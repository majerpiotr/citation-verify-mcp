// src/pageindex-client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface DocLookup {
  getDocument(docName: string): Promise<Record<string, unknown> | null>;
}

// `null` is the ONLY input that means "not found" - it is `unwrap`'s reserved value for a
// well-formed response positively stating the document does not exist. Anything else that
// cannot be read as a statement about a document is ambiguous, and ambiguity must throw so
// the caller records `unchecked`, never `unresolved` (CLAUDE.md hard rule 4): a consuming
// agent deletes `unresolved` citations, so a degraded backend must not be able to trigger
// that.
export function interpretDocResult(
  raw: Record<string, unknown> | null,
): { found: boolean; title: string | null } {
  if (raw === null) return { found: false, title: null };
  const values = Object.values(raw);
  if (values.length === 0) {
    throw new Error(
      "get_document returned an empty object, which states nothing about the document",
    );
  }
  const found = values.some((v) => Boolean(v));
  const rawTitle = raw["title"];
  const title = typeof rawTitle === "string" && rawTitle ? rawTitle : null;
  return { found, title };
}

// Concrete client. Spawns pageindex-mcp and dispatches get_document over stdio.
// Network glue - exercised by test/integration.test.ts, not the unit suite.
// NOTE: two things are unconfirmed pending Spike B (needs a live API key + network,
// forbidden in this run): (1) the get_document argument shape (doc_name vs doc_id),
// and (2) the found-vs-not-found discriminator itself - interpretDocResult's "any
// truthy value means found" heuristic would misread real not-found payloads such as
// {"error":"Document not found"}, {"status":"not_found"}, or
// {"found":false,"message":"..."} as found:true. Spike B must pin down the real shape
// before that heuristic can be trusted.
export class PageindexMcpClient implements DocLookup {
  private client: Client;

  private constructor(client: Client) {
    this.client = client;
  }

  static async connect(apiKey: string): Promise<PageindexMcpClient> {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["-y", "pageindex-mcp"],
      env: { ...process.env, PAGEINDEX_API_KEY: apiKey },
    });
    const client = new Client({ name: "citation-verify", version: "0.0.1" });
    await client.connect(transport);
    return new PageindexMcpClient(client);
  }

  async getDocument(docName: string): Promise<Record<string, unknown> | null> {
    const res = await this.client.callTool({
      name: "get_document",
      arguments: { doc_name: docName },
    });
    return unwrap(res);
  }
}

const MAX_EXCERPT_CHARS = 200;

// Short, single-line, length-capped rendering of an unusable payload, so a failure is
// diagnosable without a large response body flooding stderr.
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_EXCERPT_CHARS ? `${flat.slice(0, MAX_EXCERPT_CHARS)}...` : flat;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Reserved meaning of the return value: `null` means a well-formed response that
// positively states the document does not exist (e.g. a content block whose JSON text
// literally parses to `null`). Anything else that isn't a positive statement about the
// document - a protocol-level isError, a payload that is not JSON (a plain-text backend
// error such as "401 Unauthorized" is not a document), a JSON value that is not an
// object, or a response with no interpretable payload at all - is NOT a "not found" and
// must throw so it becomes `unchecked`, not `unresolved` (CLAUDE.md hard rule 4).
export function unwrap(res: unknown): Record<string, unknown> | null {
  const r = res as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: Array<{ text?: string }>;
  };

  if (r.isError) {
    const message = r.content?.find((block) => block.text)?.text ?? "no error detail provided";
    throw new Error(`get_document reported an error: ${message}`);
  }

  if (r.structuredContent) return r.structuredContent;

  const content = r.content ?? [];
  for (const block of content) {
    if (block.text) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.text);
      } catch {
        throw new Error(`get_document returned a non-JSON payload: ${excerpt(block.text)}`);
      }
      if (parsed === null) return null;
      if (!isPlainObject(parsed)) {
        throw new Error(
          `get_document returned a JSON payload that is not an object: ${excerpt(block.text)}`,
        );
      }
      return parsed;
    }
  }

  throw new Error("get_document returned no interpretable payload");
}
