// src/pageindex-client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describeStartupFailure, isUsableApiKey } from "./api-key.js";
import { SERVER_VERSION } from "./version.js";

export interface DocumentInfo {
  name: string;
  pageCount: number | null;
}

export type DocLookupResult = { found: true; doc: DocumentInfo } | { found: false; similar: string[] };

export interface DocLookup {
  // Resolves to found/not-found. THROWS when the check could not run.
  //
  // `signal` is the MCP request's own AbortSignal, threaded down from the tool handler. It is
  // optional so an existing implementation stays valid, but an implementation that ignores it
  // cannot be cancelled: `getNodeIds` in particular can issue dozens of sequential requests,
  // and before this parameter existed a cancelled call worked through every one of them. An
  // implementation that honours it must let the cancellation ESCAPE as a throw - never fold it
  // into a found/not-found verdict, and never into a partial node-id set (see below).
  getDocument(docName: string, signal?: AbortSignal): Promise<DocLookupResult>;
  // Every node id in the document's tree, walked recursively across pages.
  // Only called when a node was actually cited. THROWS when the check could not run.
  getNodeIds(docName: string, signal?: AbortSignal): Promise<Set<string>>;
}
// CONTRACT for every implementation of DocLookup, not just the one below: the message of
// an error it throws MUST be free of secrets. The resolver writes that message to stderr
// (which an MCP host captures into its log files) because it is the only signal an
// operator gets when a check could not run - and the resolver holds no API key, so it
// cannot redact one. `PageindexHttpClient` honours this via sanitizeLookupError, at the
// one place the key is in scope.

const DEFAULT_BASE_URL = "https://api.pageindex.ai/mcp";

// Hard cap on the number of paginated get_document_structure calls for a single
// document. Without a cap, a backend that never sets pagination.has_more to false
// would make getNodeIds loop forever. Exceeding the cap THROWS rather than returning
// the ids collected so far - a partial set would make a real node id look absent and
// produce a false `unresolved` (CLAUDE.md hard rule 4).
const MAX_STRUCTURE_PARTS = 50;

const MAX_EXCERPT_CHARS = 200;

// Short, single-line, length-capped rendering of an unusable payload, so a failure is
// diagnosable from an operator's stderr without a large response body flooding it.
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_EXCERPT_CHARS ? `${flat.slice(0, MAX_EXCERPT_CHARS)}...` : flat;
}

// Renders an arbitrary unknown value for an excerpt without ever throwing itself
// (e.g. on a value JSON.stringify can't handle).
function excerptOf(value: unknown): string {
  try {
    return excerpt(JSON.stringify(value) ?? String(value));
  } catch {
    return excerpt(String(value));
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ResultEnvelope {
  isError: boolean;
  text: string;
}

// Pulls the first text content block and the isError flag out of an MCP tool result,
// per the SDK's CallToolResult shape (content: [{type:"text", text}], isError?: boolean -
// see node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts CallToolResultSchema
// and client/index.d.ts callTool()). Throws on anything that isn't that shape; a
// response with no readable text is not a positive statement about the document, so it
// must become `unchecked`, never `unresolved`.
function getResultEnvelope(res: unknown, toolName: string): ResultEnvelope {
  if (!isPlainObject(res)) {
    throw new Error(`${toolName} returned an unrecognized response: ${excerptOf(res)}`);
  }
  // Only an absent flag or a real boolean is readable. `res["isError"] === true` used to
  // stand here, which silently collapsed EVERY other value - `"true"`, `1`, `0`, `null`, an
  // object - into "no error", so a body carrying `success: true` next to one of them was
  // read as a positive confirmation that the document exists. That is the same ambiguity
  // `interpretGetDocument` rejects when both flags are unambiguously set, so it has to be
  // rejected here too: throw, and the citation becomes `unchecked` (CLAUDE.md hard rule 4).
  //
  // The real SDK client cannot produce that shape - CallToolResultSchema declares
  // `isError: z.boolean().optional()` and Client.callTool rejects a result failing it - but
  // this function is exported and `forTesting` accepts an arbitrary ToolCaller, so the
  // guarantee is established here rather than borrowed from a caller who might not exist.
  const isErrorRaw = res["isError"];
  if (isErrorRaw !== undefined && typeof isErrorRaw !== "boolean") {
    throw new Error(
      `${toolName} returned a non-boolean isError flag, which is ambiguous: ${excerptOf(res)}`,
    );
  }
  const isError = isErrorRaw === true;
  const content = res["content"];
  if (!Array.isArray(content)) {
    throw new Error(`${toolName} returned no content array: ${excerptOf(res)}`);
  }
  const block = content.find(
    (b): b is { type: string; text: string } =>
      isPlainObject(b) && b["type"] === "text" && typeof b["text"] === "string",
  );
  if (!block) {
    throw new Error(`${toolName} returned no text content: ${excerptOf(res)}`);
  }
  return { isError, text: block.text };
}

// PURE. The unit-testable heart of the found/not-found invariant (CLAUDE.md hard rule
// 4). Per the observed shapes in docs/spike-b-findings.md section 4:
//   - `success: true` -> a real document. `page_count` maps to `pageCount`; missing or
//     non-numeric becomes `null` without throwing - the document still exists.
//   - `isError: true` whose body parses to an object with `errorCode === "NOT_FOUND"`
//     -> a real absence, positively stated by the backend.
//   - anything else - a throw, an unparseable body, an isError with a different or
//     missing code, a body that isn't an object - is ambiguous and THROWS, so the
//     caller reports `unchecked` rather than deleting a citation it never verified.
export function interpretGetDocument(res: unknown): DocLookupResult {
  const { isError, text } = getResultEnvelope(res, "get_document");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`get_document returned a non-JSON payload: ${excerpt(text)}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`get_document returned a JSON payload that is not an object: ${excerpt(text)}`);
  }

  // `success: true` only counts alongside an absent/false isError - a body carrying
  // both is not an unambiguous positive statement that the document exists.
  if (parsed["success"] === true && !isError) {
    const name = parsed["name"];
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(`get_document reported success without a usable document name: ${excerpt(text)}`);
    }
    // Only a positive integer is a usable page count. A resolver bounds-checks a cited
    // page against 1..pageCount, so `page_count: 0` (e.g. while status isn't yet
    // "completed"), a negative, or a fractional value would make every valid page
    // citation fall outside that range and get deleted. `null` already means "not
    // checked, the document verdict stands" - the document is still `found`.
    const pageCountRaw = parsed["page_count"];
    const pageCount =
      typeof pageCountRaw === "number" && Number.isInteger(pageCountRaw) && pageCountRaw > 0
        ? pageCountRaw
        : null;
    return { found: true, doc: { name, pageCount } };
  }

  if (isError && parsed["errorCode"] === "NOT_FOUND") {
    const similarRaw = parsed["similar_files"];
    const similar =
      Array.isArray(similarRaw) && similarRaw.every((s) => typeof s === "string") ? similarRaw : [];
    return { found: false, similar };
  }

  throw new Error(`get_document returned an unrecognized response: ${excerpt(text)}`);
}

// PURE. Requires the backend to have echoed back the name that was actually asked for.
//
// `interpretGetDocument` above cannot do this: it is pure over the RESPONSE and does not know
// what was requested, so before this guard any `success: true` body confirmed whatever
// document the caller happened to have in mind. The whole design rests on a literal,
// case-sensitive file-name match (README.md; docs/spike-b-findings.md section 4 measured the
// backend honouring it - `Name.pdf` for `name.pdf` comes back NOT_FOUND, never as a success
// carrying a different name), and `title` is the machine-readable delete-versus-fix signal
// built on top of that. A backend that started fuzzy-matching would therefore confirm a
// document nobody cited, and report its real name as the title of a citation that names
// something else.
//
// That is a check that could not run, not a verdict: it THROWS, so the citation becomes
// `unchecked` and `title` stays null (CLAUDE.md hard rule 4 - never `unresolved`, so nothing
// is deleted on the strength of a backend behaving unexpectedly).
//
// Defense-in-depth, not a live bug: no observed response has ever echoed a different name.
//
// RAW code-unit equality - no Unicode normalization, no case folding. This briefly normalized
// to NFC on the theory that a differing normal form is a serialization artifact, which does not
// survive contact with the contract being enforced: matching is LITERAL, so a success can only
// come back for the exact name that was sent. An echo in a different normal form therefore says
// the backend did NOT match literally, which is exactly the fuzzy behaviour this guard exists
// to catch, and nothing in docs/spike-b-findings.md observes the backend normalizing anything -
// the lenient reading was an assumption dressed as a finding.
//
// The two directions are not symmetric, which settles it. Raw equality can at worst report a
// real document `unchecked`: safe, visible, nothing deleted, and recoverable. Normalizing can
// at worst confirm a document under a name the author never wrote, which is the single outcome
// the guard is for.
//
// To loosen this, first OBSERVE the backend against a decomposed name: upload one, request it
// in the other normal form, and record in docs/spike-b-findings.md whether it is found and what
// `name` comes back. If it turns out the backend normalizes for matching, that is a published
// contract change (README's "literal file name") and not a change to this comparison alone.
function assertNameEcho(requested: string, returned: string): void {
  if (requested === returned) return;
  throw new Error(
    `get_document was asked for "${requested}" but reported a document named "${returned}"; ` +
      "names are matched literally and case-sensitively, so this is not a usable answer " +
      "about the document that was cited",
  );
}

// Generous cap on recursion depth while walking a structure tree. No realistic
// document outline nests anywhere near this deep; it exists purely so a cyclic or
// pathologically deep tree fails with a diagnosable message instead of a raw
// `RangeError: Maximum call stack size exceeded`. The direction (throw, not silently
// truncate) was already safe without this guard - this only makes the failure
// nameable.
const MAX_STRUCTURE_DEPTH = 64;

// PURE. Walks a get_document_structure `structure` array recursively through `nodes`
// children and collects every `node_id`. Throws on a shape it cannot read rather than
// silently returning fewer ids - identical reasoning to the pagination cap: a partial
// set would make a real node look absent and produce a false `unresolved`.
export function collectNodeIds(structure: unknown): Set<string> {
  const ids = new Set<string>();
  walkNodes(structure, ids, 0);
  return ids;
}

function walkNodes(entries: unknown, ids: Set<string>, depth: number): void {
  if (depth > MAX_STRUCTURE_DEPTH) {
    throw new Error(
      `document structure nesting exceeded ${MAX_STRUCTURE_DEPTH} levels - likely a cyclic or pathologically deep tree`,
    );
  }
  if (!Array.isArray(entries)) {
    throw new Error(`document structure is not an array: ${excerptOf(entries)}`);
  }
  for (const entry of entries) {
    if (!isPlainObject(entry) || typeof entry["node_id"] !== "string") {
      throw new Error(`document structure entry is missing a node_id: ${excerptOf(entry)}`);
    }
    ids.add(entry["node_id"]);
    const children = entry["nodes"];
    if (children !== undefined) {
      walkNodes(children, ids, depth + 1);
    }
  }
}

interface StructurePage {
  structure: unknown;
  hasMore: boolean;
}

// PURE. Decides whether another get_document_structure page must be fetched.
//
// Observed live against a real single-part document: the backend OMITS `pagination`
// entirely when the outline fits in one part - it is not `{has_more:false}`, the key
// is simply absent. So absence means "that was the last part", not "unreadable".
// Only an explicit `pagination.has_more === true` means "fetch another page"; a
// missing pagination block, a non-object pagination, or any `has_more` that isn't
// the literal `true` all mean stop and return what has been collected so far. This is
// NOT a weakening of the truncation guard below: it only distinguishes "this response
// legitimately has no more parts" from "a part was cut off mid-walk", and only the
// latter is dangerous enough to throw over.
export function shouldFetchNextStructurePart(pagination: unknown): boolean {
  return isPlainObject(pagination) && pagination["has_more"] === true;
}

// Parses one page of get_document_structure. The `structure` array must be readable -
// a page whose structure can't be read is genuinely ambiguous (see collectNodeIds),
// but a missing or absent pagination block is not: it is the backend's normal way of
// saying "no more parts" (see shouldFetchNextStructurePart above). An errored page must
// not have a `structure` key read out of it even if the body happens to carry one -
// the isError channel is not a positive statement about the document's structure.
function parseStructurePage(res: unknown, docName: string): StructurePage {
  const { isError, text } = getResultEnvelope(res, "get_document_structure");
  if (isError) {
    throw new Error(`get_document_structure for "${docName}" reported an error: ${excerpt(text)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`get_document_structure for "${docName}" returned a non-JSON payload: ${excerpt(text)}`);
  }
  if (!isPlainObject(parsed) || !("structure" in parsed)) {
    throw new Error(
      `get_document_structure for "${docName}" returned an unrecognized payload: ${excerpt(text)}`,
    );
  }
  return { structure: parsed["structure"], hasMore: shouldFetchNextStructurePart(parsed["pagination"]) };
}

// PURE-ish: the paging/accumulation logic, with the network call injected as
// `fetchPart`. This is exactly where under-collection would silently produce a false
// `unresolved` (a real node id that IS in the document looking absent), so it is
// exercised directly rather than only through the has_more decision in isolation. The
// HTTP transport stays untested per the plan; only the "fetch one part" seam is
// injected here - `getNodeIds` below supplies the real one.
//
// Observed live: `part` is 1-based - `part: 0` is rejected with a validation error
// (`too_small, minimum: 1`) - so the loop starts at 1 and must keep doing so. An
// out-of-range `part` (e.g. past the last real part) was observed to return the FULL
// structure again, not an empty one, so over-paging duplicates rather than truncates;
// the `Set` absorbs that harmlessly.
export async function accumulateNodeIds(
  docName: string,
  fetchPart: (part: number) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let part = 1; part <= MAX_STRUCTURE_PARTS; part++) {
    // This loop is the longest run of sequential backend requests in the server - up to
    // MAX_STRUCTURE_PARTS of them for ONE cited node, each bounded only by the SDK's 60-second
    // default. Before this check a cancellation reaching `verifyCitations` stopped the sweep
    // between citations but did nothing here, so a cancelled call still paged an entire outline
    // out of the backend; across a full document budget that is thousands of requests nobody is
    // waiting for. Throwing (rather than returning the ids collected so far) is required for the
    // same reason as the pagination cap below: a partial set makes a real node look absent and
    // produces a false `unresolved`.
    signal?.throwIfAborted();
    const res = await fetchPart(part);
    const page = parseStructurePage(res, docName);
    const pageIds = collectNodeIds(page.structure);

    // Fix: an empty FIRST part is ambiguous, not a positive statement that the
    // document has no nodes - a document with genuinely zero nodes cannot have a
    // validly cited node anyway, so `unchecked` (via a throw) is both the safe and
    // the honest verdict. A later part adding nothing is fine and must not throw.
    if (part === 1 && pageIds.size === 0) {
      throw new Error(
        `get_document_structure for "${docName}" returned no node ids on its first part, ` +
          "which is ambiguous rather than a positive statement that the document has no nodes",
      );
    }

    for (const id of pageIds) {
      ids.add(id);
    }
    if (!page.hasMore) return ids;
  }
  throw new Error(
    `get_document_structure for "${docName}" exceeded the ${MAX_STRUCTURE_PARTS}-part pagination cap`,
  );
}

// Hostnames that are unambiguously loopback, compared exactly - never by prefix or
// suffix, which is what makes "localhost.evil.com" and "127.0.0.1.evil.com" fail. Every
// entry is already in the form WHATWG URL normalizes to, so "127.1", "0x7f.1" and
// "[0:0:0:0:0:0:0:1]" are covered without loosening the comparison. IPv4-mapped IPv6
// ("[::ffff:127.0.0.1]", normalized to "[::ffff:7f00:1]") is deliberately NOT here:
// it fails closed, and an operator can always spell the address the ordinary way.
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

// PURE. Requires an https origin for the PageIndex backend, unless the host is
// loopback - a legitimate plain-HTTP case for local development. Guards the
// Authorization bearer token from ever being sent in plaintext over a non-loopback
// link. Throws rather than returning a boolean so a caller cannot forget to check the
// result. The thrown message names the rejected origin via `url.host` (never
// `url.href`), which is diagnostic and never a secret: the API key is never part of the
// base URL, and `host` omits any userinfo the URL might carry.
export function assertSecureBaseUrl(url: URL): void {
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname)) return;
  throw new Error(
    `PAGEINDEX_BASE_URL must use https: (plain http: is only allowed for localhost, 127.0.0.1 or [::1]), got ${url.protocol}//${url.host}`,
  );
}

// The minimal surface of the SDK's `Client` this module actually calls. Narrowing the
// field to this shape instead of the concrete `Client` class is the seam: any object
// with a matching `callTool` satisfies it, so a unit test can inject a fake that
// records every {name, arguments} pair without a real MCP transport. A real `Client`
// satisfies this structurally as-is, so nothing about `connect()`'s runtime behaviour
// changes.
export interface ToolCaller {
  // The third parameter is the SDK's RequestOptions, which is where an AbortSignal belongs
  // (node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts). Only `signal` is
  // declared here, because it is the only field this module sets. The second parameter exists
  // solely so the third can be reached: the SDK's `callTool(params, resultSchema, options)`
  // defaults `resultSchema` when it is passed `undefined`, so forwarding `undefined` there
  // keeps the SDK's own default rather than replacing it.
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: never,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

// Bound on a rendered lookup failure. The resolver caps its own log line as well; this cap
// exists so the message is already bounded wherever else it is handled.
const MAX_ERROR_CHARS = 400;

// PURE. Renders a caught error as a message that is safe to hand on to a caller which will
// print it: `secret` is scrubbed out of every level of the cause chain, and the result is
// length-capped.
//
// This is where redaction has to happen. The API key exists in exactly two scopes - the
// local variable in src/index.ts and the `apiKey` parameter of `connect` below - and an
// error raised while sending a request can quote the `Authorization` header value
// verbatim. Every layer above this one (the resolver, the tool handler) deliberately does
// not know the key, so none of them could remove it. `describeStartupFailure` already does
// exactly this rendering (name plus redacted message per level, never a stack, never an
// error's enumerable properties, with a depth cap and cycle protection); it is reused
// rather than reimplemented so there is one redaction routine to audit, not two.
export function sanitizeLookupError(err: unknown, secret: string): string {
  const rendered = describeStartupFailure(err, secret);
  return rendered.length > MAX_ERROR_CHARS ? `${rendered.slice(0, MAX_ERROR_CHARS)}...` : rendered;
}

// Concrete client. Connects to the PageIndex HTTP MCP endpoint and dispatches
// get_document / get_document_structure. Network glue - exercised by
// test/integration.test.ts, not the unit suite (docs/spike-b-findings.md section 1).
export class PageindexHttpClient implements DocLookup {
  // `sanitize` closes over the connection's API key (see `connect`) without storing it as a
  // field, so every error leaving this object is scrubbed of it - the DocLookup contract
  // stated above the interface.
  private constructor(
    private readonly client: ToolCaller,
    private readonly sanitize: (err: unknown) => string,
  ) {}

  static async connect(apiKey: string): Promise<PageindexHttpClient> {
    // The key guard lives HERE, not only in the binary's entry point, because this is
    // the function that interpolates the key into a header value - and it has callers
    // other than src/index.ts (the credential-gated integration suite, and any embedder
    // of the published package, since this class is exported). An unusable value that
    // got this far would reach undici, which quotes the entire invalid header value -
    // key included - in the TypeError it throws, and whatever prints that error (a test
    // runner, an MCP host's log file) would then carry a live credential.
    //
    // The message is deliberately static: it names the category of problem and never
    // echoes the value, not even a prefix of it. Throwing before the URL is even parsed
    // also means no unusable key is ever attached to a transport.
    if (!isUsableApiKey(apiKey)) {
      throw new Error(
        "PageIndex API key is unusable: it is blank, has surrounding whitespace, " +
          "contains a control character (e.g. a newline from a wrapped paste or a " +
          "two-line key file), or looks like a placeholder. Its value is not shown here " +
          "on purpose. Trim it at the read site and pass the trimmed value.",
      );
    }
    // Overridable for a self-hosted backend (docs/design.md section 6).
    const baseUrl = process.env["PAGEINDEX_BASE_URL"] ?? DEFAULT_BASE_URL;
    const url = new URL(baseUrl);
    assertSecureBaseUrl(url);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
    });
    const client = new Client({ name: "citation-verify", version: SERVER_VERSION });
    await client.connect(transport);
    return new PageindexHttpClient(client, (err) => sanitizeLookupError(err, apiKey));
  }

  // Test-only construction path: builds an instance around an injected ToolCaller
  // instead of a real MCP Client/transport, so test/pageindex-client.test.ts can pin the
  // exact wire payloads getDocument/getNodeIds send - tool name and argument key - with
  // no network and no API key. See CLAUDE.md hard rule 4 for why that payload matters:
  // a wrong argument key makes the backend return isError for every call, which
  // interpretGetDocument turns into a thrown error, so every citation becomes
  // `unchecked` forever while the rest of the unit suite stays green.
  static forTesting(caller: ToolCaller): PageindexHttpClient {
    // No key is involved on this path, so there is nothing to redact - the empty secret
    // makes sanitizeLookupError a pure rendering, and the length cap still applies.
    return new PageindexHttpClient(caller, (err) => sanitizeLookupError(err, ""));
  }

  // Re-throws with a sanitized message rather than the original error. Deliberately WITHOUT
  // `cause`: attaching the original would put the unredacted message back within reach of
  // anything that walks the chain. The throw itself is preserved exactly - it is what makes
  // the citation `unchecked` instead of `unresolved` (CLAUDE.md hard rule 4) - and nothing
  // here can turn a failure into a verdict.
  private fail(err: unknown): never {
    throw new Error(this.sanitize(err));
  }

  async getDocument(docName: string, signal?: AbortSignal): Promise<DocLookupResult> {
    try {
      const res = await this.client.callTool(
        {
          name: "get_document",
          // NOTE: the argument is `doc_name` (a case-sensitive file name including
          // extension), NOT `doc_id` - passing `doc_id` is a validation error
          // (docs/spike-b-findings.md section 4).
          arguments: { doc_name: docName },
        },
        // `undefined` keeps the SDK's default result schema - see the ToolCaller comment.
        //
        // What passing the signal here buys, stated exactly, because this comment previously
        // claimed something the SDK does not do (round-3 review): the pending call REJECTS AT
        // ONCE instead of waiting up to the SDK's 60-second request timeout, and the peer is
        // sent an MCP `notifications/cancelled`. Both are observed through the real SDK and
        // pinned in test/pageindex-client.test.ts, "what an aborted callTool actually
        // guarantees in the installed SDK".
        //
        // What it does NOT do: abort the underlying HTTP request. `Protocol.request` never
        // forwards `RequestOptions.signal` to `transport.send`, and
        // `StreamableHTTPClientTransport` builds every fetch with its own transport-wide
        // controller, aborted only by `close()`. So the request already sent stays on the wire
        // and the backend keeps working on it; whether it honours the cancellation notification
        // is the backend's business and is unobserved for PageIndex. The residual cost is
        // therefore ONE in-flight request per cancellation - the sweep's remaining lookups,
        // which is where the thousands-of-calls problem lived, are stopped by the checks in
        // `accumulateNodeIds` and in the resolver.
        undefined,
        { signal },
      );
      const result = interpretGetDocument(res);
      // Inside the try on purpose: a mismatch throws, and this catch is what turns a throw
      // into `unchecked`. A not-found needs no echo check - it carries no confirmed name.
      if (result.found) assertNameEcho(docName, result.doc.name);
      return result;
    } catch (err) {
      this.fail(err);
    }
  }

  async getNodeIds(docName: string, signal?: AbortSignal): Promise<Set<string>> {
    try {
      return await accumulateNodeIds(
        docName,
        (part) =>
          this.client.callTool(
            {
              name: "get_document_structure",
              // `doc_name`, matching get_document - see the NOTE above. `part` is 1-based
              // (docs/spike-b-findings.md section 5).
              arguments: { doc_name: docName, part },
            },
            undefined,
            { signal },
          ),
        // Passed to the pagination loop as well as to each request, and the loop is the half
        // that actually stops work: it prevents every LATER part from being requested at all.
        // The per-request signal only ends the local wait and notifies the peer (see the
        // get_document comment above); it does not abort a request already sent.
        signal,
      );
    } catch (err) {
      this.fail(err);
    }
  }
}
