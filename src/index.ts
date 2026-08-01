#!/usr/bin/env node
// src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { describeStartupFailure, isUsableApiKey } from "./api-key.js";
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
  // key, unreachable backend, anything), the server must never start with no working
  // client - a server that answered lookups without a real connection could never
  // distinguish a real absence from an outage, so unresolved-vs-unchecked would
  // collapse right here - there is no stub or degraded fallback to reach for.
  //
  // Caught right here, with `apiKey` still in scope, rather than left to the top-level
  // `.catch` below: `PageindexHttpClient.connect` puts `apiKey` into a request header,
  // and an SDK error from building that header (e.g. undici rejecting a value with an
  // embedded control character) can quote the header verbatim in its message. An MCP
  // host captures a stdio server's stderr into its log files, so that message must be
  // redacted before it is printed - and redaction needs the key, which only exists as
  // a local variable here. Threading it through this catch keeps it out of any
  // module-level state.
  try {
    const client = await PageindexHttpClient.connect(apiKey);
    const server = createServer(client);
    await server.connect(new StdioServerTransport());
  } catch (err) {
    // Only `err`'s name and a redacted rendering of its message are printed - never
    // the raw error object (whose enumerable properties, e.g. a `requestInit`, could
    // carry the key) and never a stack (which could quote the message verbatim).
    console.error(`citation-verify-mcp failed to start: ${describeStartupFailure(err, apiKey)}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  // Defense in depth only: everything that can throw with `apiKey` in scope is already
  // caught above, so nothing here should ever carry the key - there is no key in scope
  // to pass, hence the empty string, which makes `describeStartupFailure` a pure
  // name+message rendering with no redaction to do. Kept in the same shape (never the
  // raw object, never a stack) in case a future change adds a throw site between
  // reading `apiKey` and entering that try block.
  console.error(`citation-verify-mcp failed to start: ${describeStartupFailure(err, "")}`);
  process.exitCode = 1;
});
