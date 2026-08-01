# citation-verify-mcp

A standalone MCP (Model Context Protocol) server that checks, deterministically, whether
the citations in an agent's draft text actually exist in a PageIndex corpus.

## Why

A fabricated citation passes a human's eyeball test. It looks like a real source right up
until someone opens it. Anyone can generate a citation; almost nobody verifies one at
serve time, and asking a second model to check the first model's citations does not fix
this - a model-based checker can hallucinate exactly like the checker it is checking.

`citation-verify-mcp` removes the model from that trust path for the part that is
actually checkable. Existence - does the cited document exist, does the cited page fall
within it, does the cited node appear in its outline - is a deterministic fact. This
server answers it by calling PageIndex, the source of truth, in code. It exposes one MCP
tool, `verify_citations`, meant to be called in-loop by a consuming agent before it
finalizes a response.

This tool checks **existence**, not whether a document actually supports the claim made
about it. A citation that resolves is a citation that points at something real; whether
that something says what the agent claims it says is outside this tool's scope.

## Plugging it in

Add this block to your MCP host's server configuration:

```json
{
  "mcpServers": {
    "citation-verify": {
      "command": "npx",
      "args": ["-y", "citation-verify-mcp"],
      "env": {
        "PAGEINDEX_API_KEY": "<your-pageindex-api-key>"
      }
    }
  }
}
```

- `PAGEINDEX_API_KEY` (required): a PageIndex API key. The server uses it directly as the
  bearer token on its own outbound HTTP MCP connection to PageIndex - it does not spawn or
  configure anything else, and it is independent of any other PageIndex setup your host
  may already have.
- `PAGEINDEX_BASE_URL` (optional): overrides the PageIndex endpoint, for a self-hosted
  PageIndex backend. Defaults to `https://api.pageindex.ai/mcp`; leave it unset for
  PageIndex Cloud.

The server refuses to start - logging to stderr and exiting non-zero - if
`PAGEINDEX_API_KEY` is missing, blank, or looks like an unfilled placeholder (an
unsubstituted `${...}` reference, or a literal `your-api-key`-style value). An invalid but
plausible-looking key fails when the server connects to PageIndex, which is reported to
the host as a startup error rather than a working-but-broken tool.

**Unplugging is removing the block.** There is no other integration point.

The server's API key must point at the same PageIndex account the citing agent draws
its citations from. If it points at a different account, every citation the agent makes
resolves as `unresolved` - a false negative that leads a consuming agent to delete good
citations - so keep the two in sync (see `docs/design.md` section 8, constraint C1).

## The tool contract

`verify_citations(text: string)` takes the agent's draft text - not a pre-extracted list
of tokens, so extraction stays in this server's deterministic code rather than depending
on the agent to report its own citations correctly. It returns JSON in a text content
block:

```json
{
  "total": 3,
  "resolved": 1,
  "unresolved": ["missing-report.pdf"],
  "unchecked": ["node_id:0007"],
  "details": [
    {
      "token": "report.pdf#p5",
      "status": "resolved",
      "title": "report.pdf",
      "suggestion": null
    },
    {
      "token": "missing-report.pdf",
      "status": "unresolved",
      "title": null,
      "suggestion": "Did you mean \"report.pdf\"?"
    },
    {
      "token": "node_id:0007",
      "status": "unchecked",
      "title": null,
      "suggestion": "A node id alone cannot be verified: node ids are scoped to a single document's own numbering, so this citation must also name the document it belongs to."
    }
  ]
}
```

- `total` is the count of **distinct** recognized-shape citations - repeated citations of
  the same token collapse to one.
- `resolved` is a count. `unresolved` and `unchecked` are arrays of tokens.
- `details` carries one entry per distinct citation: `token`, `status`
  (`resolved` | `unresolved` | `unchecked`), `title` (the resolved document's name, or
  `null`), and `suggestion` (a string worth acting on, or `null`).
- `suggestion` is populated whenever it helps explain a non-`resolved` verdict - a
  near-miss document name for an `unresolved` document, the real page count when a cited
  page falls outside it, an explanation of which half of a combined page-plus-node
  citation failed, or (for a bare node id) why it cannot be checked at all. It can also be
  set on a **`resolved`** verdict: when PageIndex reports no page count for a document, a
  cited page is not bounds-checked and the citation still resolves, with `suggestion`
  saying the page itself was never verified.
- `token` is a **canonical** form, not the agent's verbatim text - map it back to the
  draft before acting on it. Shapes:
  - `<document>` - a document with no page or node.
  - `<document>#p<N>` or `<document>#p<N>-<M>` - a document with a page or page range.
  - `<document>#n<node-id>` - a document with a node.
  - `<document>#p<N>&n<node-id>` - a document with both a page and a node, in one
    citation (see below).
  - `node_id:<id>` - a bare node id with no document, always `unchecked`.
- If the MCP call itself fails, the tool returns an MCP error result instead of this JSON.
  Treat every citation in the text as `unchecked` in that case, never as `unresolved`.

## Recognized citation shapes

The grammar is fixed, not learned, and only `.pdf` documents are recognized. A citation
to any other extension (`.docx`, `.txt`, `.md`, ...) is not extracted at all.

**Document.** `<name>.pdf`, matched **case-sensitively** against the corpus (PageIndex's
own lookup is case-sensitive, so a citation of `Report.PDF` will not match an existing
`report.pdf`). The `.pdf` extension itself is matched case-insensitively.

A bare match is skipped entirely - not `resolved`, not `unresolved`, not `unchecked` - when
it is the path segment of a URL: a literal `://` appears earlier on the same line with no
whitespace between it and the match (`https://example.com/whitepaper.pdf` is not read as a
citation to `whitepaper.pdf`). This check is deliberately narrow: a scheme-relative URL
(`//example.com/doc.pdf`) or a bare host with no scheme marker at all (`example.com/doc.pdf`)
is **not** recognized as a URL and **is** still read as an ordinary document name - a
legitimate external link written either of those two ways can therefore be checked against
the corpus and come back `unresolved`.

**Page.** Optionally follows a document - **bare or quoted alike**, the same rules apply
to both - on the **same line**, with nothing else between them but a recognized
separator:
- glued directly, or after a `,` or `;`, or after one connector word from a closed list
  (`on`, `at`, `see`), or opened by `(` or `[`.
- Keyword `p.`, `pp.`, `page`, or `pages` (case-insensitive).
- A single page (`p.5`) or a range (`pp. 5-7`, `pp. 5 - 7`, `pages 5 to 7`). A range
  separator is a plain hyphen or the wider "en dash" character some editors substitute
  for one (spaces around either are optional), or the word "to" (spaces around it are
  required). Any other separator - the wider "em dash" character, the word "through", or
  anything else - is not read as a range: the number after it is silently dropped and
  only the first page is checked, so a range joined that way is captured and checked as
  its first page alone.
- A page marker on a different line from its document is not recognized - only a page
  form written directly against its document counts.

**Node.** `node_id: <id>` or `node_id=<id>` (keyword case-insensitive), in either order
relative to the document and the page. Unlike a page, a node has **no separator
constraint at all**: it binds to the **nearest document mention anywhere in the same
sentence** (a sentence never crosses a newline), regardless of what stands between them or
which comes first. A document with both a page and a node in the same sentence produces
**one combined citation** (`<name>.pdf#p<N>&n<node-id>`), not two. If a sentence names more
than one document, "nearest" can bind the node to the wrong one - when that matters, put
the node and the document it belongs to in a sentence of their own.

**Bracket-tag identifier.** `[<word>: <id>]` - a square-bracketed keyword (any run of
letters, chosen by whoever wrote the citation: `node`, `chunk`, `Source`, ...), a colon
(optional surrounding spaces), an id running up to the closing `]` or a newline, and a
literal closing `]`. Examples: `[node:some-doc-id-123]`, `[chunk: abc-42]`.

The value is reported **`unchecked`** and never bound to any document outside the
brackets - its id space has no defined relationship to the backend's per-document node
ordinals - **unless the value itself contains a recognizable `<name>.pdf`**. When it does,
that real document (and any page or node cited alongside it inside the same brackets, e.g.
`[Source: report.pdf p.5]`) is extracted and checked exactly as it would be in ordinary
prose, not swallowed into one opaque `unchecked` citation. Only a value that is not
document-shaped (an invented slug like `some-doc-id-123`) stays `unchecked`; cite the real
`<name>.pdf` (optionally with a page or `node_id:`) to get an actual verdict for that
citation. A tag whose value contains `://` (a URL) is excluded entirely and is not treated
as a citation of any kind, even when the URL's own path segment looks document-shaped.

**A bare `node_id: <id>` with no document anywhere in the same sentence is `unchecked`,
never `unresolved`.** Node numbering is per-document - every document has a node
`"0000"` - so a node id alone identifies nothing verifiable, and reporting it
`unresolved` would tell a consuming agent to delete a citation that was never actually
checked.

**Quoted names.** A document name containing spaces must be wrapped in double quotes or
backticks to be read exactly: `"Annual Report.pdf"`. A quoted name is honoured verbatim
only when it is genuinely file-name-shaped:
- at most 4 space-separated words,
- at most 80 characters,
- letters, digits, spaces, dots, underscores, and hyphens only (the same allowed set as an
  unquoted name, minus the space restriction).

**Quoting does not rescue a name containing any other character** - an apostrophe, `&`,
comma, colon, parenthesis, non-ASCII letter, and so on. A rejected quoted name falls
through to be matched exactly like an unquoted one, and the measured result is not one
single, predictable fallback:
- It can be **dropped entirely**: `Report (final).pdf` (quoted or not) matches nothing at
  all, because the parenthesis breaks the allowed-character run on both sides, and a real
  citation that was the only one in the text reports `total: 0`.
- It can be **read as a fragment that is not the last space-free segment**:
  `"Rapport Financiér.pdf"` is read as `r.pdf`, not `Financiér.pdf` - the allowed-character
  run is cut at the accented letter, wherever that happens to fall, not at the nearest
  space. Only when the disallowed character happens to sit exactly at a word boundary does
  the result look like "the last word": `"Report, Final.pdf"` happens to read as
  `Final.pdf`, but that is a coincidence of where the comma fell, not a rule to rely on.

Neither outcome produces a false `resolved` on its own (the wrong fragment resolves or
fails to resolve on its own merits), but a real citation to such a name can go silently
unverified with no trace in `details` (the drop case) or get checked against a wrong,
often unrecognizable document (the fragment case) - check `title` on a `resolved` verdict,
and `total` for an unexpected drop, to catch either.

Single quotes are **not** a delimiter, deliberately - ordinary apostrophes in prose
("don't", "the team's") would otherwise be misread as opening a document name.

**Inline code is not exempt.** A backtick- or double-quote-delimited span of at most 4
words ending in `.pdf` is read as a document name by the same rule that recognizes a
quoted name with spaces - including inside what is clearly a code span, not prose:
`` `cat report.pdf` `` and `` `pdftotext big-report.pdf` `` are read as the document names
`cat report.pdf` and `pdftotext big-report.pdf`. Neither exists in a real corpus, so a
harmless shell example in a draft can report `unresolved` and be flagged for removal or
replacement like a fabricated citation. This is an accepted trade-off, not a bug: the same
delimiter rule is what makes a real space-bearing file name checkable at all.

**Not recognized:**
- Any document extension other than `.pdf`.
- A page phrased as words ("page five"), a Roman numeral, or without one of the four page
  keywords.
- A page marker separated from its document by more prose than the closed connector list
  allows, or on a different line.
- A page range joined by an em dash, the word "through", or anything other than a hyphen,
  en dash, or "to" - such a range is not dropped, but truncated to its first page only
  (see the "Page" bullet above).
- A document name with spaces, unquoted, or quoted but failing the file-name shape check
  (more than 4 words, over 80 characters, or containing a character outside
  letters/digits/spaces/dots/underscores/hyphens) - both fall back to being dropped
  entirely or read as a shorter, not-necessarily-last fragment; see "Quoted names" above.
- A single-quoted name (`'report.pdf'`).
- A bare `node_id` with no document in its sentence, or a bracket tag whose value is not
  itself document-shaped - both are extracted, but always `unchecked`.
- A bracket-tag value containing `://` (a URL) - not treated as a citation at all.
- A bare document match that is a URL's own path segment (preceded on the same line by
  `://` with no whitespace in between) - not extracted at all, in any status. A
  scheme-relative or bare-host URL is not covered by this and is still read as a document
  name; see "Document" above.

## What is and is not verified

- **Document existence**: checked against PageIndex by exact, case-sensitive file name.
- **Page bounds**: checked against the document's real page count, but **only when
  PageIndex reports one**. When it does not, the citation's document/node verdict stands
  unaffected and the page is simply not bounds-checked - a `resolved` verdict can
  therefore still carry an unverified page, flagged via `suggestion`.
- **Node membership**: checked against the document's real outline, walked recursively.
- **Not verified, ever**: whether the cited document actually supports the claim the agent
  makes about it. This tool proves a source exists; it does not read it.

## Host integration

Integrating a specific host's agent behavior is outside this project's scope, but
generically: instruct the agent to call `verify_citations` on its own draft before
finalizing.

- For every `unresolved` citation: remove the claim, or search again and replace it with
  a citation that actually resolves.
- For every `unchecked` citation: **leave it in place**, optionally with a note. Do not
  delete it. `unchecked` means the corpus was never consulted for that citation - because
  of a bare node id, a timeout, or the backend being unreachable - so it may well be
  valid. Deleting it on a backend outage would delete good citations, which is the exact
  failure this server exists to prevent.
- `total: 0` means no citation of a recognized shape was found in the draft - it is not a
  clean bill of health, and not proof the text has no citations. If citations exist in
  another form, they need to be rewritten into a recognized shape (see above) before they
  can be checked.

## Instructing your agent

The block below is meant to be pasted directly into a citing agent's system prompt. Its
crux is the first paragraph: the agent must cite the document's real **file name**, not
an invented id or a display title - nothing else will ever resolve, no matter how it is
formatted.

```
Before finalizing any response that cites a source document, call `verify_citations` on
your full draft text.

Every citation must name the source's real file name, including its extension (for
example report.pdf), exactly as it is stored. An invented id, a short label, or the
document's display title will never resolve, however it is written.

Cite in one of these forms:
- A document alone: report.pdf
- A document with a page: report.pdf p.12  or  report.pdf pp. 5-9
- A document with a node: report.pdf, node_id: 0007
- A name with spaces, in double quotes: "Annual Report.pdf" p.3

After the call: for every unresolved citation, remove the claim or replace it with one
that resolves. For every unchecked citation, keep it as written - the corpus was never
consulted, so it may well be valid; do not delete it. Read suggestion even on a resolved
citation - a cited page is sometimes not verifiable, and the citation still resolves
without it. A citation written in any other form is not checked at all: total: 0 means
nothing checkable was found, not that the draft is clean.
```

This is an instructed format, not a guaranteed one. One real consuming application that
was investigated had every one of its citing agent roles uniformly instructed to use a
single citation format - yet in the one real transcript available, that format appeared
zero times. What the model actually wrote instead was free-text prose naming a source by
its human-readable title, with no file name, id, or page attached - nothing any grammar
could check. Before relying on this tool, verify what your own agent actually writes in
real output, not just what its instructions say it will. Full write-up:
`docs/spike-a-findings.md`.

## Development

```bash
npm install                          # once
npm test                             # full unit suite, offline, no key or network needed
npx vitest run test/<file>.test.ts   # a single test file
npm run build                        # tsc -> dist/
```

The integration test (`test/integration.test.ts`) is the only suite that touches the real
PageIndex backend. It is credential-gated: it skips cleanly, never fails, when its
environment variables are absent. To run it, pass the key by substitution so its value
never appears in the command text or shell history:

```bash
PAGEINDEX_API_KEY="$(cat key.txt)" \
CITATION_VERIFY_TEST_DOC_NAME="report.pdf" \
CITATION_VERIFY_TEST_NODE_ID="0003" \
npx vitest run test/integration.test.ts
```

- `PAGEINDEX_API_KEY`: a live key, read from `key.txt` in the example above (that file is
  gitignored - never commit a real key, never print or echo it).
- `CITATION_VERIFY_TEST_DOC_NAME` (required to run the suite): the exact, case-sensitive
  file name of a document that really exists in that account.
- `CITATION_VERIFY_TEST_NODE_ID` (optional): a node id that really exists in that
  document's outline. When absent, the one test that needs it is skipped rather than
  guessed at.

## Known limits

- **The citation shapes a consuming agent actually emits were checked against one real
  application, and the finding was uncomfortable.** That application's citing agent
  roles were uniformly instructed to use a single bracket-tag format, and the grammar
  above now recognizes it (as `unchecked`, per "Recognized citation shapes"). But in the
  one real transcript investigated, that instructed format was never actually used - the
  model wrote free-text prose naming a source by its display title instead, which no
  grammar can check. This does not mean the grammar's shapes are wrong; it means an
  instructed format is not a guaranteed one, and no amount of pattern-matching fixes an
  agent that names no checkable source at all. See "Instructing your agent" above and
  `docs/spike-a-findings.md` for the full write-up. Treat this as evidence to verify
  against your own agent's real output, not as a solved problem.
- A citation-shaped string that is not actually a citation can still be flagged: a
  bracket tag like `[TODO: fix this]` or `[note: reminder]` matches the generic
  `[<word>:<id>]` pattern and is reported as an `unchecked` citation. Harmless - it is
  never treated as `resolved` or `unresolved` - but it adds noise to `details`.
- The connector-word list (`on`, `at`, `see`), the quoted-name shape limits (at most 4
  words, 80 characters), and the bracket-tag keyword acceptance are fixed choices made
  without corpus evidence of what real agents actually write. They may need revisiting
  once more real output is available.
- Only `.pdf` documents are recognized; there is no support for any other extension.
- An unquoted or shape-rejected document name containing a space is not reliably read as
  its last space-free segment - it may be dropped entirely or read as a shorter fragment
  cut at the first disallowed character, wherever that falls - see "Quoted names" above.
- A quoted or backtick-delimited span of at most 4 words ending in `.pdf` is read as a
  document name even inside inline code, so a harmless shell example naming an unrelated
  `.pdf`-like word can be flagged `unresolved` - see "Quoted names" above.
- `PAGEINDEX_FOLDER_ID` is **not implemented**. Nothing in this server scopes a lookup to
  a folder; every document lookup resolves against the account's whole corpus. If two
  documents in the same account share a file name, existence still answers correctly, but
  identity does not - the lookup resolves one of them without saying which.
- The API key's capability exceeds what this server uses: the PageIndex tool surface it
  authenticates includes a document-deletion tool, which this server never calls, but a
  leaked or over-scoped key still carries that capability. Scope the key as narrowly as
  PageIndex allows.
- A citation combining a page and a node in one sentence produces a single combined
  citation. If the page is valid but the node is not (or vice versa), the whole citation
  is reported `unresolved` - there is no way to report "half of this citation failed" in
  the token/status shape, only in `suggestion`.
