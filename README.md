# citation-verify-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org)

An MCP (Model Context Protocol) server exposing a single tool, `verify_citations`. Give it
an agent's draft text; it extracts the citation tokens and checks each one against
[PageIndex](https://pageindex.ai), deterministically, in code.

Existence is verified by code calling the source of truth, never by asking a model - a
model-based citation checker hallucinates exactly like the model it is checking. A
fabricated citation passes a human's eyeball test right up until someone opens it. This
server closes the part of that gap that is actually decidable: does the cited document
exist, does the cited page fall inside it, does the cited node appear in its outline.

It checks **existence, not support**. A citation that resolves points at something real;
whether that something says what the agent claims it says is out of scope.

## Requirements

- Node.js 20 or newer.
- A PageIndex API key, for the same PageIndex account the citing agent draws its citations
  from.
- An MCP host that can launch a local stdio server (Claude Desktop, Claude Code, VS Code,
  Cursor, or anything else speaking MCP).

## Quick start

**This package is not published to npm yet**, so today the only installation path that works
is from source. Clone it, build it, and point your MCP host at the built entry point:

```bash
git clone <this repository> citation-verify-mcp
cd citation-verify-mcp
npm install
npm run build
```

```json
{
  "mcpServers": {
    "citation-verify": {
      "command": "node",
      "args": ["/absolute/path/to/citation-verify-mcp/dist/index.js"],
      "env": {
        "PAGEINDEX_API_KEY": "<your-pageindex-api-key>"
      }
    }
  }
}
```

Once the package **is** published, the same integration needs no clone and no build step:

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

Either way, that is the whole integration. **Unplugging is removing the block.** There is no
other integration point, no database, and no state kept between calls.

## What leaves your machine

**The draft text never leaves this process.** Extraction is entirely local: the grammar runs
here, in this server, and the only thing sent to PageIndex is a document *name* the grammar
extracted, plus a part number when an outline has to be paged through. Those are the complete
request payloads:

```json
{ "doc_name": "report.pdf" }
{ "doc_name": "report.pdf", "part": 2 }
```

Your prose, the claims around a citation, the surrounding sentences, and even the cited page
and node numbers are never transmitted - pages are bounds-checked and nodes are matched
locally, against the metadata that comes back. What crosses the network is the set of file
names your agent cited, over HTTPS, to `https://api.pageindex.ai/mcp` (or to whatever
`PAGEINDEX_BASE_URL` points at), with the API key as a bearer token. Nothing is written to
disk, and nothing is kept between calls.

## Example

Given a corpus containing one document, `report.pdf`, which is 11 pages long, calling
`verify_citations` with this draft:

```text
Revenue grew 12% year over year (report.pdf p.3). The regional breakdown is in
missing-report.pdf. Headcount figures appear in report.pdf p.99.
```

returns this JSON, in a text content block:

```json
{
  "total": 3,
  "resolved": 1,
  "unresolved": ["missing-report.pdf", "report.pdf#p99"],
  "unchecked": [],
  "details": [
    {
      "token": "report.pdf#p3",
      "status": "resolved",
      "title": "report.pdf",
      "suggestion": null
    },
    {
      "token": "missing-report.pdf",
      "status": "unresolved",
      "title": null,
      "suggestion": "No document with this exact name exists in the corpus, and no near match was offered. Names are matched case-sensitively and the file extension is part of the name, so a name differing only in capitalisation misses silently, with no hint. Look up the document's actual file name in the corpus before removing or rewriting this citation; do not guess at alternative capitalisations."
    },
    {
      "token": "report.pdf#p99",
      "status": "unresolved",
      "title": "report.pdf",
      "suggestion": "This document has 11 pages; the cited page is outside that range."
    }
  ]
}
```

Two citations came back `unresolved` for structurally different reasons, and **`title` is
what says which is which.** The second has `title: null`: nothing in the corpus carries that
name, and the backend offered no near name either - find the real file name or drop the claim.
The third has `title: "report.pdf"`: the document is real and only the page number was
fabricated - fix the page and keep the claim. `suggestion` explains both in English, but
`title` is the same distinction in a field you can branch on.

(The exact `suggestion` on the second entry is whatever the backend does or does not offer as
a near name for that string. Here it offered none. A live corpus containing `report.pdf` may
well answer `Did you mean "report.pdf"?` instead - the verdict is the same either way, and the
warning below about near-name suggestions applies.)

## Reading the result

`verify_citations(text: string)` takes the draft text itself, not a pre-extracted list of
tokens, so extraction stays in this server's deterministic code instead of depending on the
agent to report its own citations honestly.

| Field | Meaning |
| --- | --- |
| `total` | Count of **distinct** recognized-shape citations. Repeats collapse to one; different pages of the same document count separately. |
| `resolved` | A **count**. |
| `unresolved` | An **array** of tokens. |
| `unchecked` | An **array** of tokens. |
| `details` | One entry per distinct citation: `{ token, status, title, suggestion }`. |

Each `details` entry carries `status` (`resolved` | `unresolved` | `unchecked`), `title` and
`suggestion` (a string worth acting on, or `null`).

**`title` is the machine-readable answer to "does the cited document exist?"** It carries the
document's real file name **if and only if** the backend positively confirmed that document -
on *any* status, including an `unresolved` caused by a bad page or node, and an `unchecked`
caused by an outline that could not be read. `title: null` means the document was never
confirmed to exist. It is the field to branch on when deciding whether to fix a citation or
delete it.

### `unresolved` vs `unchecked` - the distinction everything rests on

- **`unresolved` means checked and not found.** The miss was positively established against
  the corpus.
- **`unchecked` means the check could not run** - a timeout, the backend being unreachable,
  a credential the backend rejected, a response that could not be read, or a citation that is
  unverifiable by construction. A *missing* key is not one of these: the server refuses to
  start at all in that case (see [Startup validation](#startup-validation)), so there is no
  tool call to return `unchecked` from.

A consuming agent **deletes** what comes back `unresolved`. So a backend outage reported as
`unresolved` would make it delete good work. This server never does that: any failure,
ambiguity or unreadable response becomes `unchecked`. If the MCP call itself fails, the tool
returns an MCP error result instead of the JSON above; treat every citation in the text as
`unchecked` in that case, never as `unresolved`.

Two further points that are easy to get wrong:

- **`unresolved` does not always mean the document is missing.** The miss can be the
  document, the page, or the node. A document that really is in the corpus, cited with a
  page outside its real page count or a node absent from its outline, is reported
  `unresolved` too - but it carries its real file name in `title`, while a document that does
  not exist at all is `unresolved` with `title: null`. **`title` is what distinguishes the
  two**; `suggestion` says the same thing in prose. Read `title` before deleting anything: a
  non-null one means fix the citation, not remove the claim.
- `total: 0` means no citation of a recognized shape was found in the draft - it is not a
  clean bill of health, and not proof the text has no citations. See
  [Does this work on real agent output?](#does-this-work-on-real-agent-output) below.

### About `suggestion`

`suggestion` explains a verdict; it never changes one. Every `unresolved` and every
`unchecked` carries one. It may carry the backend's own
near-name match (`Did you mean "report.pdf"?`), the real page count when a cited page falls
outside it, which half of a combined page-plus-node citation failed, or why a citation could
not be checked at all. When a document is simply not found and the backend offers no near
name, it carries a fixed reminder that names are matched case-sensitively and that a name
differing only in capitalisation misses silently - it never guesses a document.

When a lookup fails outright, `suggestion` is a **fixed** explanation: the check could not
run, that is not evidence the document is missing, and the citation must not be deleted. It
deliberately quotes no part of the underlying error - a transport error is untrusted text that
can echo a request header, and this field goes straight into a model's context. The specific
error goes to this server's stderr instead (see
[Diagnosing a failed lookup](#diagnosing-a-failed-lookup)).

`suggestion` is also set on some **`resolved`** verdicts: when PageIndex reports
no page count for a document, the cited page is not bounds-checked and the citation still
resolves, with `suggestion` saying the page itself was never verified.

**A near-name suggestion is a diagnostic, not a licence to rename a citation and keep the
same claim.** Only existence is verified. Swapping a fabricated `missing-report.pdf` for the
suggested `report.pdf` while leaving the sentence untouched converts a caught fabrication
into an uncaught one: the citation now resolves, and nothing has checked whether the real
document supports the claim.

`token` is a **canonical** form, not the agent's verbatim text - map it back to the draft
before acting on it. Shapes:

- `<document>` - a document with no page or node.
- `<document>#p<N>` or `<document>#p<N>-<M>` - a document with a page or page range.
- `<document>#n<node-id>` - a document with a node.
- `<document>#p<N>&n<node-id>` - a document with both, cited together.
- `node_id:<id>` - a bare node id with no document, always `unchecked`.

## Instructing your agent

A citation only resolves if it names the document by its **exact stored file name**,
including the extension, matched case-sensitively. PageIndex looks documents up by literal
file name, so a display title, an internal slug, or an invented id resolves nothing no matter
how it is formatted. **Making the agent write that is the host's job, not this server's** -
this tool answers whether a citation resolves; it does not help an agent discover what to
cite (see [Non-goals](#non-goals)).

The block below is meant to be pasted directly into a citing agent's system prompt.

```text
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
hyphens. A name outside that shape is either dropped entirely (checked as nothing, counted
in nothing) or silently read as a shorter fragment of itself and checked as a different
document, so prefer the shortest real file name available.

Write the file name so that nothing is glued to it. A name touching / : % + @ # = & or \
(for example sub/chapter.pdf) is not checked at all and is reported nowhere, and neither is
a name written directly against text in a script that uses no word spaces. Always put a
space after node_id: - node_id:report.pdf with no space is not checked.

After the call: for every unresolved citation, read title first. If title is not null, the
document is real and only the cited page or node missed - fix that and keep the claim;
suggestion says which half missed. If title is null, nothing in the corpus carries that
name: remove the claim or replace it with one that resolves. For every unchecked citation,
keep it as written - the corpus was never consulted, so it may well be valid; do not delete
it. Read suggestion even on a resolved citation - a cited page is sometimes not verifiable,
and the citation still resolves without it. A citation written in any other form is not
checked at all: total: 0 means nothing checkable was found, not that the draft is clean.
```

Acting on the result, generically:

- For every `unresolved` citation: **read `title` first.** Non-null means the document exists
  and only the cited page or node missed - correct that, the source is real and the claim
  should stay (`suggestion` says which half missed). `null` means nothing in the corpus
  carries that name: remove the claim, or search again and replace it with a citation that
  actually resolves.
- For every `unchecked` citation: **leave it in place**, optionally with a note. Do not
  delete it. The corpus was never consulted for it, so it may well be valid. Deleting
  `unchecked` citations during a backend outage is the exact failure this server exists to
  prevent.

## Does this work on real agent output?

**Read this before adopting.** It is the single biggest risk to this tool being useful to
you, and it is not hypothetical.

One real multi-agent application using PageIndex was investigated (read-only, ~25 agent
roles). Its corpus-citing roles were uniformly instructed to use a single citation format.
(One role of the ~25, which researches external web sources rather than the corpus, was
instructed to use a different bracket-tag convention of its own - evidence that one
application can carry more than one citation convention at a time, invented independently by
whoever wrote each agent's instructions.) In the one real saved transcript available, **the
instructed format appeared zero
times.** What the agents actually wrote instead was free-text prose naming a source by its
human-readable display title, with no file name, no id and no page - naming nothing any
grammar could look up. The full write-up is in
[`docs/spike-a-findings.md`](docs/spike-a-findings.md).

Consequences you should plan for:

- `total: 0` on a draft full of confident, unverifiable claims is a **routine** outcome, not
  an anomaly. It means nothing checkable was found, not that the text is clean.
- An instructed citation format is not a guaranteed one. Before relying on this tool,
  check what your agents actually emit in real output, not what their prompts say they
  will.
- The mitigation is upstream instruction pressure (see
  [Instructing your agent](#instructing-your-agent)), not more regex. No amount of pattern
  matching fixes an agent that names no checkable source at all.

That evidence is one application and one transcript. It is not a general law about all
agents - but it is concrete counter-evidence against assuming yours follow their
instructions.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PAGEINDEX_API_KEY` | yes | - | Used directly as the bearer token on this server's own outbound HTTP MCP connection to PageIndex. It spawns and configures nothing else, and is independent of any other PageIndex setup your host may already have. |
| `PAGEINDEX_BASE_URL` | no | `https://api.pageindex.ai/mcp` | Overrides the PageIndex endpoint, for a self-hosted backend. Leave it unset for PageIndex Cloud. |

`PAGEINDEX_BASE_URL` **must use `https:`.** The API key travels on every request as a bearer
token, and plain `http:` would put it on the wire in clear text. The single exception is a
loopback host, where plain `http:` is accepted for local development: `localhost`,
`127.0.0.1`, or `[::1]`, compared exactly. A self-hosted backend reached over plain HTTP on
any other host (`http://pageindex.internal:3000/mcp`) is rejected and the server exits;
terminate TLS in front of it, or run it on loopback.

### Startup validation

The server refuses to start - logging to stderr and exiting non-zero - if
`PAGEINDEX_API_KEY` is missing, blank, looks like an unfilled placeholder (an unsubstituted
`${...}` reference, anything still wrapped in angle brackets - including the
`<your-pageindex-api-key>` the config blocks above ship - or a literal `your-api-key`-style
value, with or without a product word in the middle), or carries a control character
*inside* the value. That last case is the easy one to misread: a key that got line-wrapped on
paste, or a two-line key file read whole, is a real key the server still refuses, because no
control character can legally sit in an `Authorization` header. Surrounding whitespace is
trimmed first, so a trailing newline alone is harmless; it is an interior `\n` or `\r` that is
fatal. The startup message names "placeholder" among the causes, so check for a stray line
break before concluding the key itself is wrong.

A non-https, non-loopback `PAGEINDEX_BASE_URL` is refused the same way. An invalid but
plausible-looking key fails when the server connects to PageIndex, which is reported to the
host as a startup error rather than a working-but-broken tool.

### Diagnosing a failed lookup

When a lookup fails, the citation comes back `unchecked` with a fixed explanation, and the
underlying error is written as **one line to this server's stderr**:

```text
citation-verify-mcp: document for "report.pdf" could not be checked: TypeError: fetch failed
```

An MCP host captures a stdio server's stderr into its own log files, so that is where the
diagnosis lands - never in the tool result a model reads. One line per distinct document name
per call, for the existence lookup (`document`) and for the outline lookup (`document
structure`) alike. The line is redacted (the API key is scrubbed at the one layer that holds
it), stripped of control characters, and capped at 400 characters, so a large error body
cannot flood a host's log. Nothing goes to stdout: stdout carries the MCP protocol stream.

Without that line, an outage, a key pointing at the wrong account and a backend change are
indistinguishable - all three produce a sweep of `unchecked` verdicts.

### Account alignment

The server's API key must point at the same PageIndex account the citing agent draws its
citations from. If it points at a different account, every citation the agent makes comes
back `unresolved` - a false negative that leads a consuming agent to delete good citations.

## How it works

1. `verify_citations` receives the draft text.
2. A fixed grammar (not a model, not a learned extractor) extracts distinct citation tokens.
3. Each distinct document is looked up once per call against PageIndex by exact,
   case-sensitive file name. Lookups run sequentially; results are memoized for the duration
   of that single call and discarded when it returns.
4. If a page was cited, it is bounds-checked against the document's real page count - but
   **only when PageIndex reports one**. When it does not, the document and node verdicts
   stand, the page is simply not bounds-checked, and `suggestion` says so on an otherwise
   `resolved` verdict.
5. If a node was cited, it is checked against the document's real outline, walked
   recursively across paginated responses.
6. Anything that could not be established positively becomes `unchecked`.

What is never verified, at any step: whether the cited document actually supports the claim
the agent makes about it. This tool proves a source exists; it does not read it.

## What counts as a citation

The grammar is fixed, not learned, and deliberately narrow. In summary:

- **Only `.pdf` documents are recognized.** A citation to any other extension (`.docx`,
  `.txt`, `.md`, ...) is not extracted at all.
- **A document is named by its exact stored file name**, extension included, matched
  **case-sensitively**: `report.pdf`. A display title, an internal slug or an invented id
  resolves nothing, however it is formatted. (The `.pdf` extension itself is matched
  case-insensitively.)
- **A page is optional**, and must follow its document on the same line, introduced by `p.`,
  `pp.`, `page` or `pages`: `report.pdf p.3`, `report.pdf (pages 5 to 7)`. A page on a
  different line, or phrased in words ("page five"), is not read. **A page phrase that names
  its own document** - any `.pdf` name following the page, separated from it by at most three
  connecting words and any amount of whitespace, quotes, brackets, emphasis marks or dashes,
  as in `methods.pdf, page 12 of results.pdf` or `page 12 of the 'results.pdf'` - binds to
  neither: the page is dropped and both documents are checked without it, rather than the
  page being bound to the wrong document. `and`, `or`, punctuation, a line break before the
  connecting words, or a fourth word ends the phrase, and the page binds to the document on
  its left again - which is what keeps `methods.pdf p.3 and results.pdf p.7` and a list with
  one citation per line binding each page correctly.
- **A node is optional**: `node_id: 0007` or `node_id=0007` binds to the nearest document
  mentioned in the same sentence, in either order. A document cited with both a page and a
  node produces one combined citation, not two.
- **A bare `node_id:` with no document in its sentence is always `unchecked`, never
  `unresolved`.** Node numbering is per-document, so a node id alone identifies nothing.
- **A bracket tag** (`[node: some-doc-id-123]`, `[chunk: abc-42]`) is `unchecked` unless its
  value names a `.pdf` document as a standalone token - then that document is checked exactly
  as it would be in prose. Written with **no space** after the colon, `[node:report.pdf]` and
  `node_id:report.pdf` stay `unchecked` instead: the colon glues the name into the id. Write
  the space. The value ends at the closing `]`, a newline or a nested `[`, so a tag whose value
  contains a `[` (`[node: abc[1]]`) is not recognized as a tag at all - though a `.pdf` written
  inside it is still checked.
- **A name containing spaces must be quoted** in double quotes or backticks *and* be
  file-name-shaped: at most 4 words, at most 80 characters, **beginning with a letter or
  digit**, and otherwise only letters, digits, spaces, dots, underscores and hyphens.
  `"Annual Report.pdf"` is read whole. A name outside that shape is dropped entirely or
  silently read as a shorter fragment of itself and checked as a different document.
- **A bare name written in a script that does not separate words with spaces** (Han,
  Hiragana, Katakana, Thai, Lao, Khmer, Myanmar, Tibetan) is not extracted at all; quote it
  to have it checked. A Latin-script name written directly against such text, with no space
  between them, is not extracted either.
- **A name must stand as its own token.** A name touching `/`, `:`, `%`, `+`, `@`, `#`, `=`,
  `&`, `\` or a format control character is not extracted in any status: `sub/chapter.pdf`,
  `ns:chapter.pdf` and `report+final.pdf` are all silent.
- **A `.pdf` that is a URL's own path segment** (`https://example.com/whitepaper.pdf`) is
  skipped entirely - not `resolved`, not `unresolved`, not `unchecked`. A scheme-relative
  (`//example.com/doc.pdf`) or bare-host (`example.com/doc.pdf`) URL is dropped too, by the
  standalone-token rule above rather than by the URL rule - so an external link written
  either way is silent, not falsely `unresolved`.

Anything outside those shapes is not checked, and the omission is silent rather than
reported: that is what `total: 0` on a draft full of citations means.

**The full reference is [`docs/citation-grammar.md`](docs/citation-grammar.md)** - every
recognized shape in exhaustive detail, the exact character and separator rules, the edge
cases, and worked examples of where the grammar over-reaches and under-reaches.

## Non-goals

These are considered decisions, not gaps. Each was scoped out deliberately.

- **No corpus discovery.** This server will not list, browse or search the corpus to help an
  agent find out what document names exist. Its job is to answer "does this citation
  resolve", not to help an agent write a citation. An agent that needs a real file name
  should get it from whatever retrieval step produced the claim in the first place; handing
  an agent a list of real names to choose from is a way to make a fabricated claim resolve,
  not a way to make it true.
- **No grounding, entailment or NLI.** Whether the document supports the claim is never
  assessed. Only existence.
- **No quote-overlap or reuse detection.**
- **No confidence scores.** Every verdict is one of three discrete states, arrived at
  deterministically.
- **No persistence and no cross-call cache.** Lookups are memoized within a single call and
  discarded when it returns.
- **No gateway or post-processing pass.** This server never rewrites, filters or intercepts
  agent output; it reports and the host decides.
- **No self-correction loop.** It does not call the agent back, retry, or repair citations
  itself.

## Limitations

Known and carried deliberately.

- **Real agent output may contain nothing this tool can check.** See
  [Does this work on real agent output?](#does-this-work-on-real-agent-output) - the single
  most important caveat here.
- **Over-reach:** a citation-shaped string that is not a citation can be flagged, and can come
  back `unresolved` rather than merely `unchecked` - a bracket tag whose value names a real
  document, or a quoted span ending in `.pdf` inside a code example, are both read as
  citations.
- **Under-reach:** a real citation can be missed with no trace at all. A citation glued to a
  preceding URL by `,`, `;`, `(` or `)` is read as part of that URL and is **dropped in every
  status** - it appears in no array and is not counted in `total`, which is indistinguishable
  from there being nothing to check. The same silence covers any name that does not stand as
  its own token: one touching `/`, `:`, `%`, `+`, `@`, `#`, `=`, `&`, `\` or a format control
  character (`sub/chapter.pdf`, `ns:chapter.pdf`, `report+final.pdf`), and one written
  directly against text in a script that uses no word spaces. That silence is deliberate: the
  alternative is to cut the name at the glue character and check the surviving fragment, which
  reports a document the author never wrote and turns a silence into a false `unresolved`. A
  bare document name in a script that does not separate words with spaces is likewise not
  extracted at all; quote it to have it checked. A space-bearing name that fails the quoted
  shape check is dropped entirely or read as a shorter fragment and checked as a different
  document.
- **A page claim can go unverified while its document is still checked.** A page phrase that
  names its own document (`page 12 of results.pdf`) is dropped rather than bound, because the
  document to its left is not its owner and binding it there would report a real document as
  `unresolved` on a page it never had. The two documents are still checked; the page claim is
  not. Cite the page directly after the name it belongs to (`results.pdf p.12`) to have it
  verified. The same rule drops the page in genuinely ambiguous cases it cannot tell apart
  from an owner (`methods.pdf p.3 -> results.pdf p.7`, `methods.pdf p.3 (see results.pdf)`) -
  a silence, and the safe half of the trade.
- **A page can still bind to the document on its left when the owner phrase runs past what
  that rule reads.** It reads at most three connecting words, and stops at a fourth
  connecting word, at `and`/`or`, at any punctuation, and at a line break before those words -
  so `methods.pdf, page 12 of the
  second half of results.pdf`, `methods.pdf, page 12, of results.pdf` and an owner the
  grammar cannot see as a document at all (`__results.pdf__`, `sub/results.pdf`) still bind
  page 12 to `methods.pdf`, which can report it `unresolved` with a non-null `title` on a
  citation that was correct. Keep a page and the name it belongs to adjacent
  (`results.pdf p.12`) and the question never arises.
- **`unchecked` where a check was possible:** `[node:report.pdf]` and `node_id:report.pdf`
  written with no space after the colon report an `unchecked` node id instead of checking the
  document. Safe (an `unchecked` citation is never deleted) but not what the author meant.
- Both directions are enumerated case by case, with worked examples, in
  [`docs/citation-grammar.md`](docs/citation-grammar.md#where-the-grammar-over-reaches-and-under-reaches).
- The connector-word list (`on`, `at`, `see`), the quoted-name shape limits and the bracket-tag
  keyword acceptance are fixed choices made without corpus evidence of what real agents write.
  They may need revisiting.
- Only `.pdf` documents are recognized; there is no support for any other extension.
- **There is no timeout budget for a whole call.** Each backend request is bounded only by the
  MCP SDK's 60-second per-request default, and citations resolve **sequentially**, each
  distinct document costing one existence lookup plus (if a node is cited) one or more
  structure requests. A draft citing many distinct documents can take many multiples of 60
  seconds in the worst case. In practice the host's own tool-call timeout fires first, which
  surfaces as an MCP error - safe, since every citation is then `unchecked` - but until it
  does, a slow backend is indistinguishable from a hang.
- **`PAGEINDEX_FOLDER_ID` is not implemented.** Nothing scopes a lookup to a folder; every
  lookup resolves against the account's whole corpus. If two documents in the same account
  share a file name, existence still answers correctly but identity does not: the lookup
  resolves one of them without saying which.
- A citation combining a page and a node produces a single verdict, so an `unresolved` there
  may mean either half failed. `suggestion` says which.
- The API key's capability exceeds what this server uses: the PageIndex tool surface it
  authenticates includes a document-deletion tool, which this server never calls, but a leaked
  or over-scoped key still carries that capability. Scope the key as narrowly as PageIndex
  allows.

## Development

```bash
npm install                          # once; also builds dist/, via the prepare hook
npm test                             # full unit suite, offline, no key or network needed
npx vitest run test/<file>.test.ts   # a single test file
npm run build                        # tsc -> dist/
```

`prepare` is what builds `dist/` on `npm install`, on `npm pack`/`npm publish` and on a
git-URL install of this repository. It stands aside when the toolchain that would do the
building is not installed, so a production install (`npm ci --omit=dev`,
`npm install --omit=dev`) succeeds and simply installs no `dist/` of its own - run
`npm run build` yourself if you need one there. A build that runs and *fails* still fails
the install; only the absence of `typescript` is treated as "nothing to do here".

**Running the tests needs a newer Node than running the server does: development requires
Node.js 20.19.0 or newer**, while the built server itself runs on any Node 20 (measured on
20.0.0), which is what `engines` declares. The gap is a dev-toolchain limit, not a runtime
one: vitest 4 bundles with rolldown, whose supported range is `^20.19.0 || >=22.12.0`.
Below that, npm skips rolldown's native binding as engine-incompatible and the wasm
fallback declares the same floor, so `npm test` fails with `Cannot find native binding`
before any test runs. `npm install`, `npm run build` and `npm run typecheck` still succeed
there, so only the test command breaks.

Whether an older 20.x appears to work is platform-dependent - a clean install on macOS
arm64 can produce a working binding on 20.13.0 while the same commit fails on Linux - so
treat the declared range as the floor rather than whatever your own machine tolerates. CI
runs the exact floor version rather than a moving major, so a break in it is visible.

The unit suite builds against fake lookup implementations, so it needs no API key and no
network. The integration test (`test/integration.test.ts`) is the only suite that touches the
real PageIndex backend, and it is credential-gated: it skips cleanly, never fails, when its
environment variables are absent. To run it, pass the key by substitution so its value never
appears in the command text or shell history:

```bash
PAGEINDEX_API_KEY="$(cat key.txt)" \
CITATION_VERIFY_TEST_DOC_NAME="report.pdf" \
CITATION_VERIFY_TEST_NODE_ID="0003" \
npx vitest run test/integration.test.ts
```

- `PAGEINDEX_API_KEY`: a live key, read from an untracked file in the example above. Never
  commit, print or echo a real key.
- `CITATION_VERIFY_TEST_DOC_NAME` (required to run the suite): the exact, case-sensitive file
  name of a document that really exists in that account.
- `CITATION_VERIFY_TEST_NODE_ID` (optional): a node id that really exists in that document's
  outline. When absent, the one test that needs it is skipped rather than guessed at.

Design background lives in [`docs/`](docs): `citation-grammar.md` for the full grammar
reference, `design.md` for the approved design, `spike-a-findings.md` for what a real
consuming application emits, `spike-b-findings.md` for the observed backend behaviour.

## Contributing

Issues and pull requests are welcome. Two things worth knowing before you open one:

- The `unresolved` / `unchecked` invariant is not negotiable. A backend failure must never be
  reported as `unresolved`. There is a test for this; changes that weaken it will not be
  merged.
- The grammar's disclosed behaviour is pinned in four places at once: `src/grammar.ts`, the
  tool description in `src/server.ts`, this README, and
  [`docs/citation-grammar.md`](docs/citation-grammar.md). A test asserts that the description
  and the prose documentation still make the same claims, so a grammar change means updating
  all of them.

Run `npm test` before opening a pull request.

## License

MIT. See [LICENSE](LICENSE).
