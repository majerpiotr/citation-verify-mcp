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
// NOTE: finalize the get_document argument shape after Spike B (doc_name vs doc_id).
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

function unwrap(res: unknown): Record<string, unknown> | null {
  const structured = (res as { structuredContent?: Record<string, unknown> }).structuredContent;
  if (structured) return structured;
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  for (const block of content) {
    if (block.text) {
      try {
        return JSON.parse(block.text) as Record<string, unknown>;
      } catch {
        return { text: block.text };
      }
    }
  }
  return null;
}
