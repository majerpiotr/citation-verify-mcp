// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { verifyCitations } from "./resolver.js";
import type { DocLookup } from "./pageindex-client.js";

export function createServer(client: DocLookup): McpServer {
  const server = new McpServer({ name: "citation-verify", version: "0.0.1" });

  server.registerTool(
    "verify_citations",
    {
      description:
        "Deterministically check whether the citations in the given text resolve against " +
        "PageIndex. Returns a JSON object in a text content block with: `total` - the number " +
        "of citation tokens found; `resolved` - a COUNT of tokens that resolved; " +
        "`unresolved` - an ARRAY of tokens that were checked against the corpus and NOT found; " +
        "`unchecked` - an ARRAY of tokens the check could not run for (e.g. backend outage); " +
        "`details` - a per-token list of `{ token, status, title }`. " +
        "For each `unresolved` citation, remove the claim or replace it with a verified " +
        "citation. Leave `unchecked` citations in place - the corpus was never consulted for " +
        "them, so they may still be valid; do not delete them. " +
        "If the call itself fails, the tool returns an MCP error result instead of this JSON; " +
        "treat every citation in the text as `unchecked` in that case, never as `unresolved`.",
      inputSchema: { text: z.string().describe("The agent's draft text to check for citations.") },
    },
    async ({ text }) => {
      const result = await verifyCitations(text, client);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  return server;
}
