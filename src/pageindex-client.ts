// src/pageindex-client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface DocLookup {
  getDocument(docName: string): Promise<Record<string, unknown> | null>;
}

export function interpretDocResult(
  raw: Record<string, unknown> | null,
): { found: boolean; title: string | null } {
  if (!raw) return { found: false, title: null };
  const values = Object.values(raw);
  const found = values.length > 0 && values.some((v) => Boolean(v));
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

// Reserved meaning of the return value: `null` means a well-formed response that
// positively states the document does not exist (e.g. a content block whose JSON text
// literally parses to `null`). Anything else that isn't a positive statement about the
// document - a protocol-level isError, or a response with no interpretable payload at
// all - is NOT a "not found" and must throw so it becomes `unchecked`, not `unresolved`
// (CLAUDE.md hard rule 4).
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
      try {
        return JSON.parse(block.text) as Record<string, unknown>;
      } catch {
        return { text: block.text };
      }
    }
  }

  throw new Error("get_document returned no interpretable payload");
}
