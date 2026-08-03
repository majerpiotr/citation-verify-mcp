// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { verifyCitations } from "./resolver.js";
import { SERVER_VERSION } from "./version.js";
import type { DocLookup } from "./pageindex-client.js";

export function createServer(client: DocLookup): McpServer {
  // SERVER_VERSION, never a literal: package.json is the one source (src/version.ts), so
  // the first `npm version patch` cannot leave this advertising a version it is not.
  const server = new McpServer({ name: "citation-verify", version: SERVER_VERSION });

  server.registerTool(
    "verify_citations",
    {
      description:
        "Deterministically checks, by code calling PageIndex (the source of truth), whether " +
        "the citations in the given text resolve - never by asking a model, which could " +
        "hallucinate like the citations it is checking. " +
        "Returns JSON in a text content block: `total` - the count of DISTINCT " +
        "recognized-shape citations (identical citations collapse to one; different pages " +
        "of the same document count separately); `resolved` - a COUNT; " +
        "`unresolved` - an ARRAY of tokens whose miss was POSITIVELY established against " +
        "the corpus, which does NOT always mean the document is missing: a document that " +
        "IS present, cited with a page outside its real page count or a node absent from " +
        "its outline, is `unresolved` too, but carries the document's real `title`: " +
        "`title` is non-null IF AND ONLY IF the backend confirmed the cited document " +
        "exists, whatever the status, so `title` - not `suggestion` - is what " +
        "distinguishes the two; `unchecked` - an ARRAY of " +
        "tokens the check could not run for (e.g. a timeout or the backend being down); " +
        "`details` - per citation `{ token, status, title, suggestion }`. `suggestion` " +
        "may carry a near-miss document name, an explanation of a miss that WAS checked " +
        "(the real page count, or a fixed case-sensitivity reminder when a document is " +
        "absent and the backend offered no near name), or an explanation of what could " +
        "not be checked; every `unresolved` and every `unchecked` carries one, so an " +
        "absent near-miss name never means an empty `suggestion`. " +
        "It should be acted on - including on a `resolved` verdict: when the " +
        "backend reports no page count, a cited page is not bounds-checked and the " +
        "citation can still resolve, with `suggestion` saying the page itself was never " +
        "verified. " +
        "For each `unresolved` citation, remove the claim or replace it with a verified " +
        "citation - unless its `title` is non-null, which means the document exists and " +
        "only the page or node missed, in which case fix that instead (`suggestion` " +
        "says which half missed). " +
        "Do NOT remove `unchecked` citations - the corpus was never consulted " +
        "for them and they may well be valid; do not delete them. If the call itself " +
        "fails, the tool returns an MCP error result instead of this JSON; treat every " +
        "citation in the text as `unchecked` in that case, never as `unresolved`. " +
        "What is verified: that the cited document exists; a cited page falls " +
        "within the document's real page count, only when the backend reports one; a " +
        "cited node id exists in the document's real outline. " +
        "Recognized citation shapes - the list below is exhaustive, and `.pdf` is the " +
        "ONLY recognized extension (a name ending in any other, e.g. `report.docx`, is " +
        "not extracted at all); page and node keywords case-insensitive: a document " +
        "written as `<name>.pdf`, matched CASE-SENSITIVELY; optionally followed - on the " +
        "SAME LINE, with no other document name in between and none named by the page " +
        "phrase itself, either glued directly, after " +
        "`,`/`;`, after a connector (`on`/`at`/`see`), or inside `()`/`[]` - by a page " +
        "(`p.5`, `pp. 5-7`, `page 12`, `pages 5 to 7`). A range needs a hyphen, en dash, " +
        'or spaced "to" - any other separator (e.g. an em dash) silently truncates to ' +
        "the first page instead of the range; a page in no recognized form at all is " +
        "simply not checked. " +
        "A page phrase that names its OWN document - `of` or `in` plus a `<name>.pdf`, as " +
        "in `methods.pdf, page 12 of results.pdf` - binds to NEITHER document: the page is " +
        "dropped and both are checked without it, rather than the page being bound to the " +
        "document on its left. Write the page against the name it belongs to " +
        "(`results.pdf p.12`) to have it verified. " +
        "`node_id: <id>` or `node_id=<id>` binds instead to the NEAREST document " +
        "mention anywhere in the SAME SENTENCE, either order, with no separator " +
        "constraint at all; if the nearest is the wrong one, use separate sentences. " +
        "A match after a same-line `://` is invisible - not resolved, unresolved, or " +
        "unchecked - while nothing between them could have ended the URL (the run ends " +
        "at the first character a URL cannot contain: any Unicode whitespace, an em or " +
        'en dash, a `"` or a typographic quote, `<>`, `{}`, `|`, `\\`, `^`, a backtick), ' +
        "and this covers a quoted or backtick-delimited match too. " +
        "A character a URL path MAY contain (`,`, `;`, `(`, `)`) does NOT end it, so a " +
        "citation glued to a URL by one of those is dropped in EVERY status - absent " +
        "from the output entirely, which looks identical to there being nothing to " +
        "check. " +
        "A name must also stand as its own token: a name touching `/`, `:`, `%`, `+`, " +
        "`@`, `#`, `=`, `&`, `\\` or a format control character is NOT extracted in ANY " +
        "status - `sub/chapter.pdf`, `ns:chapter.pdf` and `report+final.pdf` are all " +
        "silent, and so are the scheme-relative (`//host/doc.pdf`) and bare-host " +
        "(`host/doc.pdf`) URL forms, which are therefore dropped rather than falsely " +
        "`unresolved`. " +
        "A bracket tag - `[node:<id>]` or `[<word>:<id>]` - is `unchecked` UNLESS its " +
        "value names a real `<name>.pdf` as a STANDALONE token (not glued into a longer " +
        "identifier: `[node: sub/chapter.pdf]`, `[node: v1.pdf-part2]` and " +
        "`[node: report.pdfx]` stay `unchecked`); then that document (and any page/node " +
        "cited alongside it) is checked as in prose - otherwise it stays a standalone " +
        "`unchecked` id, never bound to any document (id space unconfirmed): cite the " +
        "real `<name>.pdf` for a verdict. A value carrying both a slug and a standalone " +
        "document reports only the document. " +
        "Written with NO space after the colon, `[node:report.pdf]` and " +
        "`node_id:report.pdf` are `unchecked` rather than checked, because the colon " +
        "glues the name into the id - write a space to have the document checked. " +
        "A tag whose value contains `://` is not reported as an id at all, but that " +
        "silences only the TAG: a `<name>.pdf` inside the same brackets that is not " +
        "itself part of the URL (`[Source: Annual Overview report.pdf - " +
        "https://example.com/post]` yields `report.pdf`) is still read as an ordinary " +
        "document citation and can come back `unresolved` - map it back to the bracket " +
        "before deleting anything, since the citation there may be a valid web " +
        "reference. " +
        "A name containing spaces must be wrapped in double quotes or backticks AND be " +
        "file-name-shaped (at most 4 words, 80 characters, beginning with a letter or " +
        "digit, and otherwise only letters/digits/spaces/dots/underscores/hyphens - " +
        "letters and digits of ANY script count); quoting does not rescue any other " +
        "character, which may instead drop the match entirely (`total: 0`) or leave a shorter, " +
        "not-necessarily-last fragment read as a DIFFERENT document - check `title` " +
        "on a `resolved` verdict to catch this. A leading `_`, `.` or `-` fails the " +
        'shape check even though it is legal inside an UNQUOTED name, so `"_internal ' +
        'draft.pdf"` is read as `draft.pdf`. A quoted span of up to 4 words ending ' +
        "in `.pdf` is read as a document name even inside inline code, so a shell " +
        "example can report `unresolved`. " +
        "A BARE name written in a script that does not separate words with spaces " +
        "(Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar, Tibetan) is not extracted " +
        "at all (`total: 0`), and neither is a Latin-script name written directly " +
        "against such text with no space between them; quote it to have it checked. " +
        "Single quotes are NOT a delimiter. " +
        "A bare `node_id:` with no document in the same sentence is reported `unchecked`, " +
        "never `unresolved` - node numbering is per-document, so a node id alone " +
        "identifies nothing. " +
        "`total: 0` means no citation of a recognized shape was found - NOT that the " +
        "text is free of citations, and NOT a clean bill of health; if you cited in " +
        "another form, rewrite it in a recognized form and call again. " +
        "Carrying both a " +
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
