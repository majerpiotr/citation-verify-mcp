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
        "hallucinate the same way the citations being checked might. " +
        "Returns a JSON object in a text content block with: `total` - the count of " +
        "citations of a recognized shape found; `resolved` - a COUNT of tokens that " +
        "resolved; `unresolved` - an ARRAY of tokens checked against the corpus and NOT " +
        "found; `unchecked` - an ARRAY of tokens the check could not run for (e.g. no key, " +
        "timeout, backend down); `details` - a per-citation list of `{ token, status, " +
        "title, suggestion }`. `suggestion` may carry a near-miss document name or an " +
        "explanation of what could not be checked, and is meant to be acted on, not just " +
        "displayed. " +
        "For each `unresolved` citation, remove the claim or replace it with a verified " +
        "citation. Do NOT remove `unchecked` citations - the corpus was never consulted " +
        "for them, so they may well be valid; do not delete them. If the call itself " +
        "fails, the tool returns an MCP error result instead of this JSON; treat every " +
        "citation in the text as `unchecked` in that case, never as `unresolved`. " +
        "What is verified: that the cited document exists; that a cited page falls " +
        "within the document's real page count; that a cited node id exists in the " +
        "document's real outline. " +
        "Recognized citation shapes: a document written as `<name>.pdf`, alone or " +
        "followed by a page (`p.5`, `pp. 5-7`, `page 12`, `pages 5-7`) or by `node_id: " +
        "<id>` (either order, within the same sentence). The document name is matched " +
        "CASE-SENSITIVELY, matching the backend. A name containing spaces must be wrapped " +
        "in double quotes or backticks to be read exactly; unquoted, only its last " +
        "space-free segment is read (`Annual Report 2024.pdf` is read as `2024.pdf`). A " +
        "quoted name is honoured verbatim only when it is file-name-shaped: at most 4 " +
        "words and at most 80 characters; a name containing an apostrophe, `&`, a comma, " +
        "a colon, or a non-ASCII character will not be read correctly. Single quotes are " +
        "NOT a delimiter. A bare `node_id:` with no document in the same sentence is " +
        "reported `unchecked`, never `unresolved` - node numbering is per-document, so a " +
        "node id alone identifies nothing. Page ranges written with the word \"to\" are " +
        "not recognized; use a hyphen (`5-7`). " +
        "`total: 0` means no citation OF A RECOGNIZED SHAPE was found - NOT that the text " +
        "is free of citations, and NOT a clean bill of health; if you cited in another " +
        "form, rewrite it in a recognized form and call again. A citation carrying both a " +
        "page and a node returns ONE verdict, so an `unresolved` there may mean either " +
        "half failed - the `suggestion` says which.",
      inputSchema: { text: z.string().describe("The agent's draft text to check for citations.") },
    },
    async ({ text }) => {
      const result = await verifyCitations(text, client);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  return server;
}
