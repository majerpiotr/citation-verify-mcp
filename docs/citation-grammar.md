# Citation grammar reference

This is the complete reference for the citation shapes `citation-verify-mcp` recognizes.
That server exposes one MCP tool, `verify_citations`: give it an agent's draft text and it
extracts citation tokens with a fixed grammar (not a model, not a learned extractor) and
checks each one against [PageIndex](https://pageindex.ai) in code. The
[README](../README.md) carries the summary and the installation instructions; this document
is the exhaustive version, for when you need to know exactly why a particular string in a
draft was or was not read as a citation.

Three things are worth knowing before reading any rule below, because every rule here
depends on them.

**A document must be named by its exact stored file name.** Including the extension, matched
case-sensitively. PageIndex looks documents up by literal file name, so a display title, an
internal slug, or an invented id resolves nothing no matter how it is formatted.

**`unresolved` and `unchecked` are not the same verdict.** `unresolved` means the citation
was checked against the corpus and positively not found. `unchecked` means the check could
not run at all: a missing key, a timeout, an unreachable backend, or a citation that is
unverifiable by construction. A consuming agent deletes what comes back `unresolved`, so a
failure reported as `unresolved` would make it delete good work. Nothing in this grammar may
turn a failed check into `unresolved`.

**A shape absent from this document is not checked.** It is not reported wrong; it is not
reported at all. `total: 0` means no citation of a recognized shape was found in the draft.
It is not a clean bill of health, and not proof the text has no citations.

The grammar is fixed, not learned. **Only `.pdf` documents are recognized** - a citation to
any other extension (`.docx`, `.txt`, `.md`, ...) is not extracted at all.

## Document

`<name>.pdf`, matched **case-sensitively** against the corpus (PageIndex's own lookup is
case-sensitive, so a citation of `Report.PDF` will not match an existing `report.pdf`). The
`.pdf` extension itself is matched case-insensitively.

An unquoted name may contain letters, combining marks, digits, `_`, `-` and `.`, in **any
script** - `raport-glowny-2024.pdf`, `otchet-2024.pdf` and `bogoseo.pdf` written in their own
scripts are all read whole. It may not contain a space (quote it, see
[Quoted names](#quoted-names)), and unlike a quoted name it *may* begin with `_`, `-` or `.`
(`_internal-draft.pdf` is read whole).

One deliberate exception: a **bare** name written in a script that does not separate words
with spaces (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar, Tibetan) is not extracted at
all (`total: 0`), because there is no space to tell the reader where the name starts, and
guessing would report a whole clause the author never wrote as a document name. **Quote such a
name** and it is read exactly; a Latin-script name glued directly to such text is still read
normally.

### URLs

A match is skipped entirely - not `resolved`, not `unresolved`, not `unchecked` - when it is
the path segment of a URL: a literal `://` appears earlier on the same line and nothing
between it and the match could have ended the URL, so `https://example.com/whitepaper.pdf` is
not read as a citation. The URL is taken to run until the first character a URL cannot contain
at all: any Unicode whitespace (`U+00A0` included), an em or en dash character, a `"` or a
typographic quote, `<`, `>`, `{`, `}`, `|`, `\`, `^`, or a backtick. (A straight apostrophe is
legal in a URL, so it does not end the run.) This applies to quoted and backtick-delimited
matches too.

Two gaps in that rule, both deliberate:

- A character a URL path *may* legally contain (`,`, `;`, `(`, `)` and the other RFC 3986
  sub-delimiters) does **not** end the URL run. A real citation glued to a URL by one of them
  (`https://example.com/doc.pdf;annual-report.pdf`) is read as part of that URL and is
  therefore **dropped in every status**: absent from `details`, uncounted in `total`, which
  looks exactly like there being nothing to check. Breaking the run on those characters would
  instead un-suppress the last path segment of any real URL containing one earlier in its path
  (`.../w_100,h_200/report.pdf`), turning a safe silence into a false `unresolved` on a valid
  external link. That is the worse of the two errors, so the silence is kept and disclosed.
- A scheme-relative URL (`//example.com/doc.pdf`) or a bare host with no scheme marker
  (`example.com/doc.pdf`) is **not** recognized as a URL and **is** still read as an ordinary
  document name, so a legitimate external link written either way can come back `unresolved`.

## Page

Optionally follows a document (bare or quoted alike) on the **same line**, with nothing
between them but a recognized separator:

- Glued directly, or after a `,` or `;`, or after one connector word from a closed list
  (`on`, `at`, `see`), or opened by `(` or `[`.
- Keyword `p.`, `pp.`, `page` or `pages`, case-insensitive.
- A single page (`p.5`) or a range (`pp. 5-7`, `pages 5 to 7`). A range separator is a plain
  hyphen, the wider en dash character some editors substitute for one (spaces around either
  optional), or the word "to" (spaces required). Any other separator - the em dash character,
  the word "through", anything else - is not read as a range: the number after it is silently
  dropped and only the first page is checked.
- A page marker on a different line from its document is not recognized.

## Node

`node_id: <id>` or `node_id=<id>` (keyword case-insensitive), in either order relative to the
document and the page. Unlike a page, a node has **no separator constraint at all**: it binds
to the **nearest document mention anywhere in the same sentence** (a sentence never crosses a
newline), regardless of what stands between them or which comes first. A document with both a
page and a node in the same sentence produces **one combined citation**
(`<name>.pdf#p<N>&n<node-id>`), not two. If a sentence names more than one document, "nearest"
can bind the node to the wrong one - put the node and its document in a sentence of their own
when that matters.

**A bare `node_id: <id>` with no document anywhere in the same sentence is `unchecked`, never
`unresolved`.** Node numbering is per-document (every document has a node `"0000"`), so a node
id alone identifies nothing verifiable, and reporting it `unresolved` would tell a consuming
agent to delete a citation that was never actually checked.

## Bracket-tag identifier

`[<word>: <id>]` - a square-bracketed keyword (any run of letters, chosen by whoever wrote the
citation: `node`, `chunk`, `Source`, ...), a colon (optional surrounding spaces), an id running
up to the closing `]` or a newline, and a literal `]`. Examples: `[node:some-doc-id-123]`,
`[chunk: abc-42]`.

The value is reported **`unchecked`** and never bound to any document outside the brackets -
its id space has no defined relationship to the backend's per-document node ordinals -
**unless the value names a recognizable `<name>.pdf` as a standalone token**. When it does,
that real document (and any page or node cited alongside it inside the same brackets, e.g.
`[Source: report.pdf p.5]`) is extracted and checked exactly as it would be in ordinary prose.

"Standalone" is the operative word: the name must not be glued into a longer identifier.
`[node: sub/chapter.pdf]`, `[node: v1.pdf-part2]`, `[node: report.pdfx]` and
`[node: 2024.pdf.chunk3]` all stay `unchecked`, because reading a document name out of an
opaque id would check something the author never cited. A value that is simply not
document-shaped (an invented slug like `some-doc-id-123`) stays `unchecked` too. When a value
carries **both** a slug and a standalone document (`[node: abc-123 report.pdf]`), the document
is checked and the slug is reported in no status at all.

A tag whose value contains `://` is not reported as an id at all. **That silences only the
tag, not the brackets.** The ordinary document scan still reads the same text, so a
`<name>.pdf` elsewhere inside the same brackets - one that is not itself part of the URL - is
still extracted and checked like any other citation:
`[Source: Annual Overview report.pdf - https://blog.example.com/post]` yields `report.pdf`,
which can come back `unresolved` if no such file is in the corpus. The URL's *own* path
segment is still suppressed. Map an `unresolved` token back to the bracket it came from before
deleting anything: the citation there may be a perfectly valid web reference this tool cannot
verify.

## Quoted names

A document name containing spaces must be wrapped in double quotes or backticks to be read
exactly: `"Annual Report.pdf"`. A quoted name is honoured verbatim only when it is genuinely
file-name-shaped:

- at most 4 space-separated words,
- at most 80 characters,
- **beginning with a letter or digit**,
- and otherwise letters, combining marks, digits, spaces, dots, underscores and hyphens only
  (letters and digits of any script, so `"Rapport Financier.pdf"` is honoured whole).

The leading-character rule is where the quoted and unquoted paths differ, and the difference is
silent: `_`, `.` and `-` are legal inside an unquoted name **and at its start**
(`_internal-draft.pdf` is read whole), but a quoted name starting with one fails the shape
check. `"_internal draft.pdf"` is therefore read as `draft.pdf`, a different document.

**Quoting does not rescue a name containing any other character** (an apostrophe, `&`, comma,
colon, parenthesis, `+`, `/`, ...) nor one over the word or character limit. A rejected quoted
name falls through to be matched exactly like an unquoted one, and the result is not one single
predictable fallback:

- It can be **dropped entirely**: `Report (final).pdf` (quoted or not) matches nothing at all,
  because the parenthesis breaks the allowed-character run on both sides. A real citation that
  was the only one in the text then reports `total: 0`.
- It can be **read as a fragment cut at the disallowed character**, which is not the same as
  "the last space-free segment": `"Report+Final.pdf"` has no space in it at all, yet is read as
  `Final.pdf`, because the run is cut at the `+` wherever that falls. `"Report: Final.pdf"`
  reads as `Final.pdf` and `"R&D summary.pdf"` as `summary.pdf`; those two only *look* like
  "the last word" by coincidence.
- The word limit fails the same way and is easy to hit with a real file name:
  `"Q3 Financial Results Final Draft.pdf"` is five words, so it is rejected and read as
  `Draft.pdf`.

No such outcome produces a false `resolved` on its own, but a real citation to such a name can
go silently unverified with no trace in `details` (the drop case) or get checked against a
wrong, often unrecognizable document (the fragment case). Check `title` on a `resolved`
verdict, and `total` for an unexpected drop, to catch either.

Single quotes are **not** a delimiter, deliberately: ordinary apostrophes in prose ("don't",
"the team's") would otherwise be misread as opening a document name.

**Inline code is not exempt.** A backtick- or double-quote-delimited span of at most 4 words
ending in `.pdf` is read as a document name by the same rule that recognizes a quoted name with
spaces, including inside what is clearly a code span: `` `cat report.pdf` `` is read as the
document name `cat report.pdf`. Neither exists in a real corpus, so a harmless shell example in
a draft can report `unresolved`. This is an accepted trade-off: the same delimiter rule is what
makes a real space-bearing file name checkable at all.

## Not recognized

- Any document extension other than `.pdf`.
- A page phrased as words ("page five"), a Roman numeral, or without one of the four page
  keywords.
- A page marker separated from its document by more prose than the closed connector list
  allows, or on a different line.
- A page range joined by an em dash character, the word "through", or anything other than a
  hyphen, en dash or "to" - truncated to its first page rather than dropped.
- A document name with spaces, unquoted, or quoted but failing the file-name shape check -
  dropped entirely or read as a shorter fragment.
- A **bare** document name in a script that does not separate words with spaces.
- A single-quoted name (`'report.pdf'`).
- A bare `node_id` with no document in its sentence, or a bracket tag whose value does not name
  a document as a standalone token - both are extracted, but always `unchecked`.
- A bracket-tag value containing `://`, as an id (a standalone `<name>.pdf` elsewhere in the
  same brackets still is).
- A document match that is a URL's own path segment.

## Where the grammar over-reaches and under-reaches

Both directions are known, measured and carried deliberately. Neither is a bug report.

### Over-reach: a non-citation reported as a citation

- A bracket tag like `[TODO: fix this]` matches the generic `[<word>: <id>]` pattern and is
  reported as an `unchecked` citation. Noise in `details`, but harmless: an `unchecked` entry
  is never deleted.
- A bracket tag whose value *does* name a standalone document is checked for real and can come
  back `unresolved`, even when the surrounding tag was never meant as a corpus citation.
- A quoted or backtick-delimited span of up to 4 words ending in `.pdf` is read as a document
  name even inside inline code, so `` `cat report.pdf` `` in a draft can report `unresolved`
  for a file nobody ever cited.

### Under-reach: a real citation not reported at all

- A citation glued to a preceding URL by `,`, `;`, `(` or `)` is read as part of that URL and
  is **dropped in every status**: absent from `details`, uncounted in `total`, which is
  indistinguishable from there being nothing to check.
- A bare document name in a script that does not separate words with spaces is not extracted
  at all; quote it to have it checked.
- A document name with spaces that fails the quoted shape check is either dropped entirely or
  read as a shorter fragment, and the fragment is checked as a different document.
- A page marker on a different line from its document, or separated from it by more prose than
  the closed connector list allows, is not read as a page - the document alone is checked and
  the page claim goes unverified.

The connector-word list (`on`, `at`, `see`), the quoted-name shape limits and the bracket-tag
keyword acceptance are fixed choices made without corpus evidence of what real agents write.
They may need revisiting.

## Changing the grammar

The disclosed behaviour above is pinned in three places at once: `src/grammar.ts`, the tool
description in `src/server.ts`, and the README plus this document. `test/server.test.ts`
asserts that the tool description and the prose documentation still make the same claims, so a
grammar change means updating all of them together.
