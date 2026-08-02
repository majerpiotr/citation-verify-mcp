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
  PageIndex Cloud. **It must use `https:`** - the API key travels on every request as a
  bearer token, and plain `http:` would put it on the wire in clear text. The single
  exception is a loopback host, where plain `http:` is accepted for local development:
  `localhost`, `127.0.0.1`, or `[::1]`, compared exactly. A self-hosted backend reached
  over plain HTTP on any other host (`http://pageindex.internal:3000/mcp`) is rejected and
  the server exits; terminate TLS in front of it, or run it on loopback.

The server refuses to start - logging to stderr and exiting non-zero - if
`PAGEINDEX_API_KEY` is missing, blank, looks like an unfilled placeholder (an
unsubstituted `${...}` reference, or a literal `your-api-key`-style value), or carries a
control character *inside* the value. That last case is the easy one to misread: a key that
got line-wrapped on paste, or a two-line key file read in whole, is a real key the server
still refuses, because no control character can legally sit in an `Authorization` header.
Surrounding whitespace is trimmed first, so a trailing newline alone is harmless - it is an
interior `\n` or `\r` that is fatal. The startup message names "placeholder" among the
causes, so check for a stray line break before concluding the key itself is wrong. A
`PAGEINDEX_BASE_URL` that is not https (and not loopback) is refused
the same way. An invalid but plausible-looking key fails when the server connects to
PageIndex, which is reported to the host as a startup error rather than a
working-but-broken tool.

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
- **`unresolved` does not always mean the document is missing.** It means a miss was
  positively established against the corpus - and that miss can be the document, the page,
  or the node. A document that really is in the corpus, cited with a page outside its real
  page count or a node absent from its outline, is reported `unresolved` with `title: null`
  exactly like a document that does not exist at all. Only `suggestion` distinguishes the
  two ("This document has 10 pages; the cited page is outside that range." versus a
  near-miss name or nothing), so a consuming agent must read it before deleting anything:
  a real source cited with a wrong page number should have the page corrected, not the
  claim removed.
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

An unquoted name may contain letters, combining marks, digits, `_`, `-` and `.`, in **any
script** - `raport-główny-2024.pdf`, `отчёт-2024.pdf` and `보고서.pdf` are all read whole.
It may not contain a space (quote it - see "Quoted names"), and unlike a quoted name it
*may* begin with `_`, `-` or `.` (`_internal-draft.pdf` is read whole).

One deliberate exception: a **bare** name written in a script that does not separate words
with spaces - Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar, Tibetan - is not
extracted at all (`total: 0`), because there is no space to tell the reader where the name
starts, and guessing would report a whole clause the author never wrote as a document name.
**Quote such a name** (`"年次報告書.pdf"`) and it is read exactly; a Latin-script name glued
directly to such text (`詳細はreport.pdf`) is still read normally.

A match is skipped entirely - not `resolved`, not `unresolved`, not `unchecked` - when it is
the path segment of a URL: a literal `://` appears earlier on the same line and nothing
between it and the match could have ended the URL (`https://example.com/whitepaper.pdf` is
not read as a citation to `whitepaper.pdf`). The URL is taken to run until the first
character a URL cannot contain at all: any Unicode whitespace (`U+00A0` included), an em or
en dash, a `"` or a typographic quote, `<`, `>`, `{`, `}`, `|`, `\`, `^`, or a backtick.
(A straight apostrophe `'` is *not* in that group - it is legal in a URL, so it does not
end the run.) This applies to a quoted or backtick-delimited match as well as a bare one,
so ``https://example.com/`report.pdf` `` yields nothing either.

Two gaps in that rule, both deliberate, both with consequences worth knowing:

- A character a URL path *may* legally contain - `,`, `;`, `(`, `)` and the other RFC 3986
  sub-delimiters - does **not** end the URL run. A real citation glued to a URL by one of
  them (`https://example.com/doc.pdf;annual-report.pdf`) is read as part of that URL and is
  therefore **dropped in every status**: it is absent from `details`, and `total` does not
  count it, which looks exactly like there being nothing to check. Breaking the run on those
  characters would instead un-suppress the last path segment of any real URL containing one
  earlier in its path (`.../w_100,h_200/report.pdf`), turning a safe silence into a false
  `unresolved` on a valid external link - the worse of the two errors, so the silence is
  kept and disclosed here rather than traded away.
- A scheme-relative URL (`//example.com/doc.pdf`) or a bare host with no scheme marker at
  all (`example.com/doc.pdf`) is **not** recognized as a URL and **is** still read as an
  ordinary document name - a legitimate external link written either of those two ways can
  therefore be checked against the corpus and come back `unresolved`.

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
ordinals - **unless the value names a recognizable `<name>.pdf` as a standalone token**.
When it does, that real document (and any page or node cited alongside it inside the same
brackets, e.g. `[Source: report.pdf p.5]`) is extracted and checked exactly as it would be
in ordinary prose, not swallowed into one opaque `unchecked` citation.

"Standalone" is the operative word: the name must not be glued into a longer identifier.
`[node: sub/chapter.pdf]`, `[node: v1.pdf-part2]`, `[node: report.pdfx]` and
`[node: 2024.pdf.chunk3]` all stay `unchecked`, because reading a document name out of an
opaque id would check something the author never cited - and the identical id written as
`node_id: sub/chapter.pdf` has always stayed `unchecked`, so the two syntaxes must agree. A
value that is simply not document-shaped (an invented slug like `some-doc-id-123`) stays
`unchecked` too; cite the real `<name>.pdf` (optionally with a page or `node_id:`) to get an
actual verdict. When a value carries **both** a slug and a standalone document
(`[node: abc-123 report.pdf]`), the document is checked and the slug is reported in no
status at all - the slug is unverifiable either way, while the document is a checkable claim
that must not hide behind `unchecked`.

A tag whose value contains `://` (a URL) is not reported as an id at all. **That silences
only the tag, not the brackets.** The ordinary document scan still reads the same text, so a
`<name>.pdf` elsewhere inside the same brackets - one that is not itself part of the URL -
is still extracted and checked like any other citation:
`[Source: Annual Overview report.pdf - https://blog.example.com/post]` yields `report.pdf`,
which can come back `unresolved` if no such file is in the corpus. The URL's *own* path
segment is still suppressed (`[Source: https://example.com/doc.pdf]` yields nothing).
Map an `unresolved` token back to the bracket it came from before deleting anything: the
citation there may be a perfectly valid web reference that this tool cannot verify.

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
- **beginning with a letter or digit**,
- and otherwise letters, combining marks, digits, spaces, dots, underscores, and hyphens
  only - letters and digits of any script, so `"Rapport Financiér.pdf"` and
  `"raport główny.pdf"` are both honoured whole.

The leading-character rule is where the quoted and unquoted paths differ, and the
difference is silent: `_`, `.` and `-` are legal *inside* an unquoted name **and at its
start** (`_internal-draft.pdf` is read whole), but a quoted name starting with one fails
the shape check. `"_internal draft.pdf"` is therefore not read as itself - it falls back to
the unquoted path and is read as `draft.pdf`, a different document.

**Quoting does not rescue a name containing any other character** - an apostrophe, `&`,
comma, colon, parenthesis, `+`, `/`, and so on - nor one over the word or character limit.
A rejected quoted name falls through to be matched exactly like an unquoted one, and the
measured result is not one single, predictable fallback:
- It can be **dropped entirely**: `Report (final).pdf` (quoted or not) matches nothing at
  all, because the parenthesis breaks the allowed-character run on both sides, and a real
  citation that was the only one in the text reports `total: 0`.
- It can be **read as a fragment cut at the disallowed character**, which is not the same
  thing as "the last space-free segment": `"Report+Final.pdf"` has no space in it at all,
  yet is read as `Final.pdf`, because the run is cut at the `+` wherever that falls.
  `"Report: Final.pdf"` reads as `Final.pdf` and `"R&D summary.pdf"` as `summary.pdf` -
  those two only *look* like "the last word" because the disallowed character happened to
  sit at a word boundary, which is a coincidence, not a rule to rely on.
- The word limit fails the same way and is easy to hit with a real file name:
  `"Q3 Financial Results Final Draft.pdf"` is five words, so it is rejected and read as
  `Draft.pdf`.

No such outcome produces a false `resolved` on its own (the wrong fragment resolves or
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
  (more than 4 words, over 80 characters, not beginning with a letter or digit, or
  containing a character outside letters/marks/digits/spaces/dots/underscores/hyphens) -
  both fall back to being dropped entirely or read as a shorter fragment cut at the
  offending character; see "Quoted names" above.
- A **bare** document name in a script that does not separate words with spaces (Han,
  Hiragana, Katakana, Thai, Lao, Khmer, Myanmar, Tibetan) - quote it and it is read
  exactly; see "Document" above.
- A single-quoted name (`'report.pdf'`).
- A bare `node_id` with no document in its sentence, or a bracket tag whose value does not
  name a document as a standalone token - both are extracted, but always `unchecked`.
- A bracket-tag value containing `://` (a URL) - the tag itself is not reported as an id,
  though a standalone `<name>.pdf` elsewhere in the same brackets still is; see
  "Bracket-tag identifier" above.
- A document match that is a URL's own path segment (preceded on the same line by `://`
  with nothing between that could have ended the URL) - not extracted at all, in any
  status, whether it is bare, quoted or backtick-delimited. Two things are not covered by
  this: a scheme-relative or bare-host URL, which is still read as a document name, and a
  citation glued to a URL by `,`, `;`, `(` or `)`, which is swallowed into the URL and
  dropped in every status; see "Document" above.

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

- For every `unresolved` citation: **read `suggestion` first.** If it says the document
  exists and only the cited page is out of range (or the cited node is absent), correct
  that - the source is real and the claim should stay. Otherwise remove the claim, or
  search again and replace it with a citation that actually resolves.
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

A quoted name is only honoured when it is at most 4 words and 80 characters, starts with
a letter or digit, and contains nothing but letters, digits, spaces, dots, underscores and
hyphens. A name outside that shape is silently read as a shorter fragment of itself and
checked as a different document, so prefer the shortest real file name available.

After the call: for every unresolved citation, read suggestion before acting. If it says
the document exists and only the cited page or node missed, fix that and keep the claim -
the source is real. Otherwise remove the claim or replace it with one that resolves. For
every unchecked citation, keep it as written - the corpus was never consulted, so it may
well be valid; do not delete it. Read suggestion even on a resolved citation - a cited
page is sometimes not verifiable, and the citation still resolves without it. A citation
written in any other form is not checked at all: total: 0 means nothing checkable was
found, not that the draft is clean.
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
  `[<word>:<id>]` pattern and is reported as an `unchecked` citation - noise in `details`,
  but harmless, since a value that names no document is never `resolved` or `unresolved`.
  A bracket tag whose value *does* name a standalone document is a different matter: it is
  checked like any other citation and can come back `unresolved`, so `[node: 3f9a-chunk.pdf]`
  is a real verdict, not noise. See "Bracket-tag identifier" above.
- The connector-word list (`on`, `at`, `see`), the quoted-name shape limits (at most 4
  words, 80 characters), and the bracket-tag keyword acceptance are fixed choices made
  without corpus evidence of what real agents actually write. They may need revisiting
  once more real output is available.
- Only `.pdf` documents are recognized; there is no support for any other extension.
- A shape-rejected document name is not reliably read as its last space-free segment - it
  may be dropped entirely or read as a shorter fragment cut at the disallowed character,
  wherever that falls, even in a name with no space in it at all - see "Quoted names"
  above. (A non-ASCII letter is no longer such a character: names in any script are read
  whole. What still cuts a run is punctuation outside `_`, `-` and `.`)
- A citation glued to a preceding URL by `,`, `;`, `(` or `)` is read as part of that URL
  and is **dropped in every status** - it appears in no array and is not counted in
  `total`, which is indistinguishable from there being nothing to check. Deliberate: the
  alternative un-suppresses the tail of real URLs whose paths contain those characters,
  producing a false `unresolved` on a valid external link - see "Document" above.
- A **bare** document name written in a script that does not separate words with spaces
  (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar, Tibetan) is not extracted at all.
  Quote it and it is read exactly - see "Document" above.
- **There is no timeout budget for a whole call.** Each backend request is bounded only by
  the MCP SDK's 60-second per-request default, and citations are resolved **sequentially**,
  each distinct document costing one existence lookup plus (if a node is cited) one or more
  structure requests. A draft citing many distinct documents can therefore take many
  multiples of 60 seconds in the worst case before the tool returns anything. In practice
  the host's own tool-call timeout fires first, which surfaces as an MCP error - safe,
  since every citation is then `unchecked` rather than `unresolved` - but until it does, a
  slow backend is indistinguishable from a hang.
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
