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
        "Check whether the citations in the given text resolve against PageIndex. " +
        "Returns resolved / unresolved (checked, not found) / unchecked (could not check).",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => {
      const result = await verifyCitations(text, client);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  return server;
}
