#!/usr/bin/env node
// src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isUsableApiKey } from "./api-key.js";
import { PageindexMcpClient } from "./pageindex-client.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const apiKey = process.env.PAGEINDEX_API_KEY;
  // `!apiKey` narrows out `undefined`/`""` for the compiler; `isUsableApiKey` covers
  // the rest (whitespace-only, unsubstituted shell placeholders, doc-style
  // placeholders). Both must hold for `apiKey` to be usable below.
  if (!apiKey || !isUsableApiKey(apiKey)) {
    console.error(
      "PAGEINDEX_API_KEY is missing, empty, or looks like a placeholder value. " +
        "Set a real key in the mcp_servers env block.",
    );
    process.exitCode = 1;
    return;
  }
  const client = await PageindexMcpClient.connect(apiKey);
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("citation-verify-mcp failed to start:", err);
  process.exit(1);
});
