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
        "Only citations written as `node_id: <id>` or `<name>.pdf p.<N>` are recognized, so " +
        "`total: 0` means no citation OF A RECOGNIZED SHAPE was found - NOT that the text is " +
        "free of citations; if you cited in any other form, rewrite it in a recognized shape " +
        "and call again. Existence is checked at DOCUMENT level only: a page reference inside " +
        "a token is not verified, so a resolved token does not confirm the page. " +
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
