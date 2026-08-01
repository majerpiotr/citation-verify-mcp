// src/pageindex-client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface DocumentInfo {
  name: string;
  pageCount: number | null;
}

export type DocLookupResult = { found: true; doc: DocumentInfo } | { found: false; similar: string[] };

export interface DocLookup {
  // Resolves to found/not-found. THROWS when the check could not run.
  getDocument(docName: string): Promise<DocLookupResult>;
  // Every node id in the document's tree, walked recursively across pages.
  // Only called when a node was actually cited. THROWS when the check could not run.
  getNodeIds(docName: string): Promise<Set<string>>;
}

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
  const isError = res["isError"] === true;
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
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (let part = 1; part <= MAX_STRUCTURE_PARTS; part++) {
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

// PURE. Requires an https origin for the PageIndex backend, unless the host is
// loopback (localhost or 127.0.0.1) - a legitimate plain-HTTP case for local
// development. Guards the Authorization bearer token from ever being sent in
// plaintext over a non-loopback link. Throws rather than returning a boolean so a
// caller cannot forget to check the result. The thrown message names the rejected
// origin, which is diagnostic and never a secret - the API key is never part of the
// base URL.
export function assertSecureBaseUrl(url: URL): void {
  if (url.protocol === "https:") return;
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "http:" && isLoopback) return;
  throw new Error(
    `PAGEINDEX_BASE_URL must use https: (plain http: is only allowed for localhost or 127.0.0.1), got ${url.protocol}//${url.host}`,
  );
}

// Concrete client. Connects to the PageIndex HTTP MCP endpoint and dispatches
// get_document / get_document_structure. Network glue - exercised by
// test/integration.test.ts, not the unit suite (docs/spike-b-findings.md section 1).
export class PageindexHttpClient implements DocLookup {
  private constructor(private readonly client: Client) {}

  static async connect(apiKey: string): Promise<PageindexHttpClient> {
    // Overridable for a self-hosted backend (docs/design.md section 6).
    const baseUrl = process.env["PAGEINDEX_BASE_URL"] ?? DEFAULT_BASE_URL;
    const url = new URL(baseUrl);
    assertSecureBaseUrl(url);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
    });
    const client = new Client({ name: "citation-verify", version: "0.0.1" });
    await client.connect(transport);
    return new PageindexHttpClient(client);
  }

  async getDocument(docName: string): Promise<DocLookupResult> {
    const res = await this.client.callTool({
      name: "get_document",
      // NOTE: the argument is `doc_name` (a case-sensitive file name including
      // extension), NOT `doc_id` - passing `doc_id` is a validation error
      // (docs/spike-b-findings.md section 4).
      arguments: { doc_name: docName },
    });
    return interpretGetDocument(res);
  }

  async getNodeIds(docName: string): Promise<Set<string>> {
    return accumulateNodeIds(docName, (part) =>
      this.client.callTool({
        name: "get_document_structure",
        // `doc_name`, matching get_document - see the NOTE above. `part` is 1-based
        // (docs/spike-b-findings.md section 5).
        arguments: { doc_name: docName, part },
      }),
    );
  }
}
