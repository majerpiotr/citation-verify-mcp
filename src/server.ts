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
        "recognized-shape citations (identical citations collapse to one; different pages " +
        "of the same document count separately); `resolved` - a COUNT; `unresolved` - an " +
        "ARRAY of tokens confirmed absent from the corpus; `unchecked` - an ARRAY of " +
        "tokens the check could not run for (e.g. a timeout or the backend being down); " +
        "`details` - per citation `{ token, status, title, suggestion }`. `suggestion` " +
        "may carry a near-miss document name or an explanation of what could not be " +
        "checked, and should be acted on - including on a `resolved` verdict: when the " +
        "backend reports no page count, a cited page is not bounds-checked and the " +
        "citation can still resolve, with `suggestion` saying the page itself was never " +
        "verified. " +
        "For each `unresolved` citation, remove the claim or replace it with a verified " +
        "citation. Do NOT remove `unchecked` citations - the corpus was never consulted " +
        "for them and they may well be valid; do not delete them. If the call itself " +
        "fails, the tool returns an MCP error result instead of this JSON; treat every " +
        "citation in the text as `unchecked` in that case, never as `unresolved`. " +
        "What is verified: that the cited document exists; that a cited page falls " +
        "within the document's real page count, only when the backend reports one; that a " +
        "cited node id exists in the document's real outline. " +
        "Recognized citation shapes, page and node keywords case-insensitive: a document " +
        "written as `<name>.pdf`, matched CASE-SENSITIVELY; optionally followed - on the " +
        "SAME LINE, with no other document name in between, either glued directly, after " +
        "`,`/`;`, after a connector (`on`/`at`/`see`), or inside `()`/`[]` - by a page " +
        "(`p.5`, `pp. 5-7`, `page 12`, `pages 5 to 7`) and/or by `node_id: <id>` or " +
        "`node_id=<id>` (either order). A range needs a hyphen, en dash, or spaced " +
        '"to" - any other separator (e.g. an em dash) silently truncates to the first ' +
        "page instead of the range; a page in no recognized form at all is simply not " +
        "checked. " +
        "A bracket tag - `[node:<id>]` or `[<word>:<id>]` - is recognized too, but " +
        "always `unchecked`: unlike `node_id:`, it never binds to a nearby document (its " +
        "id space is unconfirmed), so cite the real `<name>.pdf` for a verdict. A " +
        "URL-valued tag (`[Source: https://...]`) is not a citation at all. " +
        "A name containing spaces must be wrapped in double quotes or backticks AND be " +
        "file-name-shaped (at most 4 words, 80 characters, letters/digits/spaces/dots/" +
        "underscores/hyphens only) to be read exactly. Otherwise - including a rejected " +
        "quoted name - only its last space-free segment is read: " +
        '"Team\'s Report.pdf" is silently checked AS `Report.pdf`, a DIFFERENT document, ' +
        "not left unchecked - check `title` on a `resolved` verdict to catch this. " +
        "Single quotes are NOT a delimiter. " +
        "A bare `node_id:` with no document in the same sentence is reported `unchecked`, " +
        "never `unresolved` - node numbering is per-document, so a node id alone " +
        "identifies nothing. " +
        "`total: 0` means no citation of a recognized shape was found - NOT that the text " +
        "is free of citations, and NOT a clean bill of health; if you cited in another " +
        "form, rewrite it in a recognized form and call again. A citation carrying both a " +
        "page and a node returns ONE verdict, so an `unresolved` there may mean either " +
        "half failed - `suggestion` says which. " +
        "`token` (and each `unresolved`/`unchecked` entry) is a canonical form, not " +
        "verbatim text - `<document>` plus optional `#p<page-or-range>` and/or a node " +
        "marker (`#n<node-id>`, `&n<node-id>` after a page, or bare `node_id:<id>`) - map " +
        "it back to your draft before acting.",
      inputSchema: { text: z.string().describe("The agent's draft text to check for citations.") },
    },
    async ({ text }) => {
      const result = await verifyCitations(text, client);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  return server;
}
