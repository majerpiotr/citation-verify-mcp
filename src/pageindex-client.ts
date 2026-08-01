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

  if (parsed["success"] === true) {
    const name = parsed["name"];
    if (typeof name !== "string") {
      throw new Error(`get_document reported success without a document name: ${excerpt(text)}`);
    }
    const pageCountRaw = parsed["page_count"];
    const pageCount = typeof pageCountRaw === "number" ? pageCountRaw : null;
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

// PURE. Walks a get_document_structure `structure` array recursively through `nodes`
// children and collects every `node_id`. Throws on a shape it cannot read rather than
// silently returning fewer ids - identical reasoning to the pagination cap: a partial
// set would make a real node look absent and produce a false `unresolved`.
export function collectNodeIds(structure: unknown): Set<string> {
  const ids = new Set<string>();
  walkNodes(structure, ids);
  return ids;
}

function walkNodes(entries: unknown, ids: Set<string>): void {
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
      walkNodes(children, ids);
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
// saying "no more parts" (see shouldFetchNextStructurePart above).
function parseStructurePage(res: unknown, docName: string): StructurePage {
  const { text } = getResultEnvelope(res, "get_document_structure");

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

// Concrete client. Connects to the PageIndex HTTP MCP endpoint and dispatches
// get_document / get_document_structure. Network glue - exercised by
// test/integration.test.ts, not the unit suite (docs/spike-b-findings.md section 1).
export class PageindexHttpClient implements DocLookup {
  private constructor(private readonly client: Client) {}

  static async connect(apiKey: string): Promise<PageindexHttpClient> {
    // Overridable for a self-hosted backend (docs/design.md section 6).
    const baseUrl = process.env["PAGEINDEX_BASE_URL"] ?? DEFAULT_BASE_URL;
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
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
    const ids = new Set<string>();
    for (let part = 1; part <= MAX_STRUCTURE_PARTS; part++) {
      const res = await this.client.callTool({
        name: "get_document_structure",
        arguments: { doc_name: docName, part },
      });
      const page = parseStructurePage(res, docName);
      for (const id of collectNodeIds(page.structure)) {
        ids.add(id);
      }
      if (!page.hasMore) return ids;
    }
    throw new Error(
      `get_document_structure for "${docName}" exceeded the ${MAX_STRUCTURE_PARTS}-part pagination cap`,
    );
  }
}
