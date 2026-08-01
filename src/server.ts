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
        "Deterministically checks, by code calling PageIndex (the source of truth), whether " +
        "the citations in the given text resolve - never by asking a model, which could " +
        "hallucinate like the citations it is checking. " +
        "Returns JSON in a text content block: `total` - the count of DISTINCT " +
        "recognized-shape citations (repeated citations of the same document collapse to " +
        "one); `resolved` - a COUNT; `unresolved` - an ARRAY of tokens confirmed absent " +
        "from the corpus; `unchecked` - an ARRAY of tokens the check could not run for " +
        "(e.g. a timeout or the backend being down); `details` - per citation `{ token, " +
        "status, title, suggestion }`. `suggestion` may carry a near-miss document name or " +
        "an explanation of what could not be checked, and should be acted on - including " +
        "on a `resolved` verdict: when the backend reports no page count, a cited page is " +
        "not bounds-checked and the citation can still resolve, with `suggestion` saying " +
        "the page itself was never verified. " +
        "For each `unresolved` citation, remove the claim or replace it with a verified " +
        "citation. Do NOT remove `unchecked` citations - the corpus was never consulted " +
        "for them, so they may well be valid; do not delete them. If the call itself " +
        "fails, the tool returns an MCP error result instead of this JSON; treat every " +
        "citation in the text as `unchecked` in that case, never as `unresolved`. " +
        "What is verified: that the cited document exists; that a cited page falls " +
        "within the document's real page count, only when the backend reports one; that a " +
        "cited node id exists in the document's real outline. " +
        "Recognized citation shapes, page and node keywords case-insensitive: a document " +
        "written as `<name>.pdf`, matched CASE-SENSITIVELY; optionally followed - on the " +
        "SAME LINE, with no other document name in between, either glued directly or " +
        "after `,`/`;` or a connector (`on`/`at`/`see`) or inside `()`/`[]` - by a page " +
        "(`p.5`, `pp. 5-7`, `page 12`, `pages 5 to 7`; a hyphen, en dash, or the word " +
        '"to" all separate a range) and/or by `node_id: <id>` or `node_id=<id>` (either ' +
        "order). A page written any other way is not checked. " +
        "A name containing spaces must be wrapped in double quotes or backticks AND be " +
        "file-name-shaped (at most 4 words, at most 80 characters, no apostrophe, `&`, a " +
        "comma, a colon, or a non-ASCII character) to be read exactly. Otherwise - " +
        "including a rejected quoted name - only its last space-free segment is read: " +
        '"Team\'s Report.pdf" is silently checked AS `Report.pdf`, a DIFFERENT document, ' +
        "not merely left unchecked, so check `title` on a `resolved` verdict to catch " +
        "this. Single quotes are NOT a delimiter. " +
        "A bare `node_id:` with no document in the same sentence is reported `unchecked`, " +
        "never `unresolved` - node numbering is per-document, so a node id alone " +
        "identifies nothing. " +
        "`total: 0` means no citation of a recognized shape was found - NOT that the text " +
        "is free of citations, and NOT a clean bill of health; if you cited in another " +
        "form, rewrite it in a recognized form and call again. A citation carrying both a " +
        "page and a node returns ONE verdict, so an `unresolved` there may mean either " +
        "half failed - `suggestion` says which. " +
        "`token` (and each `unresolved`/`unchecked` entry) is a canonical form, not your " +
        "verbatim text: `<document>` optionally followed by `#p<page-or-range>`, and " +
        "optionally by a node marker - `#n<node-id>` alone, or `&n<node-id>` when a page " +
        "precedes it - or `node_id:<id>` for a bare node; map it back to your draft " +
        "before acting.",
      inputSchema: { text: z.string().describe("The agent's draft text to check for citations.") },
    },
    async ({ text }) => {
      const result = await verifyCitations(text, client);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  return server;
}
