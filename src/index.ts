#!/usr/bin/env node
// src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isUsableApiKey } from "./api-key.js";
import { PageindexHttpClient } from "./pageindex-client.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  // Trim at the read site, not only in the guard: a key with a trailing newline would
  // otherwise pass validation and then fail auth on every lookup.
  const apiKey = process.env.PAGEINDEX_API_KEY?.trim();
  // `!apiKey` narrows out `undefined`/`""` for the compiler; `isUsableApiKey` covers
  // the rest (whitespace-only, unsubstituted shell placeholders, doc-style
  // placeholders). Both must hold for `apiKey` to be usable below.
  if (!apiKey || !isUsableApiKey(apiKey)) {
    console.error(
      "PAGEINDEX_API_KEY is missing, empty, or looks like a placeholder value. " +
        "Set a real key in the mcpServers env block. To point at a self-hosted " +
        "backend instead of the default PageIndex endpoint, set PAGEINDEX_BASE_URL.",
    );
    // process.exitCode (not process.exit) so buffered stderr writes flush before the
    // process exits naturally: under an MCP host, stderr is a pipe, and Node's writes
    // to a pipe are asynchronous - process.exit would risk truncating this message.
    process.exitCode = 1;
    return;
  }
  // Connecting is the load-bearing step for CLAUDE.md hard rule 4: if this throws (bad
  // key, unreachable backend, anything), `main()` must reject and fall through to the
  // top-level `.catch` below rather than starting a server with no working client. A
  // server that answered lookups without a real connection could never distinguish a
  // real absence from an outage, so unresolved-vs-unchecked would collapse right here -
  // there is no stub or degraded fallback to reach for.
  const client = await PageindexHttpClient.connect(apiKey);
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("citation-verify-mcp failed to start:", err);
  process.exit(1);
});
