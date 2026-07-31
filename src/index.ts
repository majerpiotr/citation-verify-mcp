#!/usr/bin/env node
// src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PageindexMcpClient } from "./pageindex-client.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const apiKey = process.env.PAGEINDEX_API_KEY;
  if (!apiKey || apiKey.startsWith("replace-with")) {
    console.error("PAGEINDEX_API_KEY missing or placeholder. Set it in the mcp_servers env block.");
    process.exit(1);
  }
  const client = await PageindexMcpClient.connect(apiKey);
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("citation-verify-mcp failed to start:", err);
  process.exit(1);
});
