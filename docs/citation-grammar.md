# Citation grammar reference

This is the complete reference for the citation shapes `citation-verify-mcp` recognizes.
That server exposes one MCP tool, `verify_citations`: give it an agent's draft text and it
extracts citation tokens with a fixed grammar (not a model, not a learned extractor) and
checks each one against [PageIndex](https://pageindex.ai) in code. The
[README](../README.md) carries the summary and the installation instructions; this document
is the exhaustive version, for when you need to know exactly why a particular string in a
draft was or was not read as a citation.

Four things are worth knowing before reading any rule below, because every rule here
depends on them.

**A document must be named by its exact stored file name.** Including the extension, matched
case-sensitively. PageIndex looks documents up by literal file name, so a display title, an
internal slug, or an invented id resolves nothing no matter how it is formatted.

**`unresolved` and `unchecked` are not the same verdict.** `unresolved` means the citation
was checked against the corpus and positively not found. `unchecked` means the check could
not run at all: a timeout, an unreachable backend, a rejected credential, a response that
could not be read, or a citation that is unverifiable by construction. (A *missing* key is
not one of them - the server refuses to start at all in that case, so no tool call happens.)
A consuming agent deletes what comes back `unresolved`, so a
failure reported as `unresolved` would make it delete good work. Nothing in this grammar may
turn a failed check into `unresolved`.

**`title` says whether the cited document exists.** It carries the document's real file name
if and only if the backend positively confirmed that document, on any status - so an
`unresolved` with a `title` is a real document cited with a wrong page or node (fix the
citation) and an `unresolved` with `title: null` names nothing that exists (find the real
source, or drop the claim).

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
[Quoted names](#quoted-names)), and it may begin with `_`, `-` or `.`
(`_internal-draft.pdf` is read whole) - as may a quoted name, provided the mark is bound
directly to a letter or digit.

### A bare name must stand as its own token

A bare name is only extracted when what sits on each side of it is a **boundary character**,
or the start or end of the text. The boundary set is closed and small: whitespace, every
script's brackets and quotation marks (Unicode `Ps`, `Pe`, `Pi`, `Pf`), `,` `;` `!` `?`,
the CJK and fullwidth punctuation `。` `、` `，` `；` `！` `？`, `'` `"` and the backtick,
`*` `|` `<` `>`, the four typographic dash characters (`U+2014`, `U+2013`, `U+2015`,
`U+2012` - the ASCII hyphen is a name character, not a boundary), and the ellipsis `…`.

Everything else **continues** the identifier, so a name touching it is not a standalone token
and is not extracted **in any status**. In particular `/`, `:`, `%`, `+`, `@`, `#`, `=`, `&`,
`\` and every format control character (a zero-width joiner, for instance) glue a name to its
neighbour and silence it: `sub/chapter.pdf`, `ns:chapter.pdf`, `report+final.pdf`,
`report@2024.pdf` and `x=report.pdf` all yield nothing.

The allowlist direction is the whole point. Enumerating *glue* characters instead means an
unforeseen character defaults to "cut here, emit the fragment that survives" - which reports
`2024.pdf` for a name the author never wrote, checks a different document, and comes back
`unresolved`. An unforeseen character now defaults to silence, which costs a check and is
recoverable by quoting the name. A false `unresolved` deletes correct work; a silence does
not.

The same rule governs the end of a run, after skipping any trailing `.` and `:`, so
`report.pdf: the figures are current.` is a citation followed by prose, while `report.pdfx`,
`2024.pdf.chunk3` and `v1.pdf-part2` are single opaque tokens and are not citations.

One deliberate exception in the same family: a **bare** name written in a script that does not
separate words with spaces (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar, Tibetan) is
not extracted at all (`total: 0`), because there is no space to tell the reader where the name
starts, and guessing would report a whole clause the author never wrote as a document name.
**Quote such a name** and it is read exactly.

A no-space-script character is neither a name character nor a boundary, so this cuts both
ways: **a Latin-script name written directly against such text, with no space between them, is
silent too.** That is a real loss and it is accepted deliberately. The two shapes are
identical to the grammar - a run of name characters beginning immediately after a
no-space-script character - so nothing can separate "a Latin file name after a particle" from
"the Latin tail of a name written in that script". One of the two had to give, and emitting
the tail of a real name as a document is the deletion direction. Quote the name to have it
checked.

### URLs

A match is skipped entirely - not `resolved`, not `unresolved`, not `unchecked` - when it is
the path segment of a URL: a literal `://` appears earlier on the same line and nothing
between it and the match could have ended the URL, so `https://example.com/whitepaper.pdf` is
not read as a citation. The URL is taken to run until the first character a URL cannot contain
at all: any Unicode whitespace (`U+00A0` included), an em or en dash character, a `"` or a
typographic quote, `<`, `>`, `{`, `}`, `|`, `\`, `^`, or a backtick. (A straight apostrophe is
legal in a URL, so it does not end the run.) This applies to quoted and backtick-delimited
matches too.

Two things that rule does not do, both deliberate:

- A character a URL path *may* legally contain (`,`, `;`, `(`, `)` and the other RFC 3986
  sub-delimiters) does **not** end the URL run. A real citation glued to a URL by one of them
  (`https://example.com/doc.pdf;annual-report.pdf`) is read as part of that URL and is
  therefore **dropped in every status**: absent from `details`, uncounted in `total`, which
  looks exactly like there being nothing to check. Breaking the run on those characters would
  instead un-suppress the last path segment of any real URL containing one earlier in its path
  (`.../w_100,h_200/report.pdf`), turning a safe silence into a false `unresolved` on a valid
  external link. That is the worse of the two errors, so the silence is kept and disclosed.
- A scheme-relative URL (`//example.com/doc.pdf`) or a bare host with no scheme marker
  (`example.com/doc.pdf`) is **not** recognized as a URL at all - there is no `://` to find.
  It is nonetheless silent, because the `/` in front of the file name is an identifier
  continuation and the name is therefore not a standalone token (see
  [A bare name must stand as its own token](#a-bare-name-must-stand-as-its-own-token)). The
  outcome is the safe one - nothing is reported, rather than a false `unresolved` on a valid
  external link - but it is a silence, not coverage: this belongs on the under-reach list, not
  the over-reach list. A `.pdf` written after a bare host with a *space* between them
  (`On example.com, see report.pdf`) is an ordinary citation and is checked.

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

### A page phrase that names its own document binds to neither

A document name following a page states whose page it is, and that owner is not the name to
its left. In `methods.pdf, see page 12 of results.pdf`, the page is **dropped**: both
documents are extracted and checked, neither carries a page.

The rule is structural rather than a list of prepositions, and it asks the ordinary document
scan - not a second, private idea of what a name looks like - whether a name follows. Reading
forward from the end of the page marker it steps over:

- whitespace of every kind, `U+00A0` and a line break included;
- brackets and quotation marks of every script, every dash character, and `"` `'` `` ` `` `*`
  `<` `>` `~` - so `'results.pdf'`, `(results.pdf)`, `[results.pdf]`, `<results.pdf>`,
  `**results.pdf**`, `« »`, `「 」` and `"Annual Report.pdf"` are all recognized as the owner;
- **at most three** connecting words, of any language (`of`, `in`, `from`, `within`,
  `of the`, `as printed in`, ...).

and stops at anything else. So `report.pdf, page 3 of 40` and `report.pdf, page 12 of the
appendix` still bind as before - the run ends at the `.` with no document found.

Four things end the phrase and leave the page bound to the document on its **left**. The
first two are why the rule reads this way at all; the last two are its residue.

- **`and` or `or`.** They coordinate two separate items, so in `methods.pdf p.3 and
  results.pdf p.7` the page really does belong to the name on the left. Note the direction of
  this closed list against the one it replaced: an unforeseen word now makes the page
  **drop** (a silence), where an unforeseen preposition used to make it **bind** to the wrong
  document. It is the same allowlist reasoning the boundary rule is built on.
- **A line break before the connecting words**, i.e. the phrase must begin on the page's own
  line. A list with one citation per line (`- methods.pdf p.3`, `- results.pdf p.7`) therefore
  keeps every page it states, while an owner phrase that merely wraps (`page 12
  of\nresults.pdf`) is still read.
- **Any other punctuation**, `,` `;` `:` `.` `/` `|` included. `methods.pdf, page 12, of
  results.pdf` and `methods.pdf, page 12: results.pdf` still bind page 12 to `methods.pdf`.
- **A fourth connecting word.** `methods.pdf, page 12 of the second half of results.pdf`
  still binds page 12 to `methods.pdf`.

A name the grammar cannot see as a document at all is not an owner either, for the same
reason it is not a citation: `methods.pdf, page 12 of __results.pdf__` and
`... of sub/results.pdf` bind page 12 to `methods.pdf`, because the trailing `_` and the `/`
make those names non-standalone tokens (see
[A bare name must stand as its own token](#a-bare-name-must-stand-as-its-own-token)). A URL
*is* honoured as an owner even though its path segment is never extracted: `page 12 of
https://example.com/results.pdf` drops the page rather than binding it left. So is a quoted
name over the 80-character limit, for the same reason: the grammar reads it as one name and
reads nothing else out of it, so binding the page left would be a false `unresolved` with
nothing extracted that could compensate for it.

The words inside a quoted owner are part of the name, not connecting words, so they do not
count against the three-word budget: `methods.pdf, page 12 of "Annual Report Draft Final.pdf"`
drops the page, and so does an owner quoted in a script that separates no words - the shape
this grammar tells you to quote in the first place.

The rule errs towards dropping, and the cases where it drops a page that would have bound
correctly are the price: `methods.pdf p.3 -> results.pdf p.7` and `methods.pdf p.3 (see
results.pdf)` lose the page, because a dash and a bracket are exactly what an owner phrase is
allowed to contain. A dropped page is a silence and is recoverable by writing the page against
its own name; a page bound to the wrong document is not.

Dropping is deliberate, and it is the same choice made everywhere else in this grammar.
Binding the page to the document on the left is the worst outcome available: a `methods.pdf`
with fewer than 12 pages comes back `unresolved` carrying a non-null `title` - the signal that
means "this document is real, fix the page" - so a consuming agent corrupts a citation that
was correct, while the genuine page-12 claim about `results.pdf` is reported `resolved` with
its page never checked. Binding forward instead would be a second guess in the opposite
direction. Dropping costs one page check, is visible as a citation with no page, and is
recoverable: write the page against the name it belongs to (`results.pdf p.12`).

Note that the connector `and` already behaved this way (`a.pdf and page 12 of b.pdf` never
bound the page, because `and` is not in the connector list) - this makes `,`, `;` and the
connector words agree with it rather than disagree.

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

The id runs to the first boundary character, by the same rule as a bare name, which makes the
space after the colon load-bearing. `node_id: report.pdf` steps aside and checks the document;
`node_id:report.pdf`, with no space, reports one `unchecked` node id whose text happens to be
`report.pdf`, because a `:` is an identifier continuation and the name is not standalone. The
bracket-tag syntax behaves identically: `[node: report.pdf]` is checked, `[node:report.pdf]` is
`unchecked`. The direction is safe - an `unchecked` citation is never deleted - and the fix is
the space.

## Bracket-tag identifier

`[<word>: <id>]` - a square-bracketed keyword (any run of letters, chosen by whoever wrote the
citation: `node`, `chunk`, `Source`, ...), a colon (optional surrounding spaces), an id running
up to the closing `]`, a newline or a nested `[`, whichever comes first, and a literal `]`.
Examples: `[node:some-doc-id-123]`, `[chunk: abc-42]`.

Because the id stops at a nested `[`, **a tag whose value contains a `[` is not recognized as a
tag at all**: `[node: abc[1]]` reports nothing rather than an `unchecked` id of `abc[1`. The
limit exists so that a stray unclosed `[` can neither swallow unrelated later text nor make the
scan cost grow faster than the draft does. It costs no document its check - the ordinary
document scan reads the whole text regardless of brackets, so `[Source: report.pdf [v2]]` still
yields `report.pdf`.

The value is reported **`unchecked`** and never bound to any document outside the brackets -
its id space has no defined relationship to the backend's per-document node ordinals -
**unless the value names a recognizable `<name>.pdf` as a standalone token**. When it does,
that real document (and any page or node cited alongside it inside the same brackets, e.g.
`[Source: report.pdf p.5]`) is extracted and checked exactly as it would be in ordinary prose.

A name **quoted** inside the value names one too - `[Source: "Annual Report.pdf"]` is checked,
by the same [quoted-name rule](#quoted-names) that governs a quotation anywhere else. That is
what keeps the quote-it-to-have-it-checked remedy working inside a tag, and it is the only way
to cite a name written in a script that separates no words there, since the bare rule declines
that shape by design.

"Standalone" is the operative word, and it is not a bracket-tag rule: it is
[the grammar's single rule](#a-bare-name-must-stand-as-its-own-token) about where a name may
begin and end, applied identically in prose, in `node_id:` and here, from one definition. So
the three syntaxes cannot disagree about the same string. `[node: sub/chapter.pdf]`,
`[node: v1.pdf-part2]`, `[node: report.pdfx]` and
`[node: 2024.pdf.chunk3]` all stay `unchecked`, because reading a document name out of an
opaque id would check something the author never cited - and `sub/chapter.pdf` written in
plain prose is silent for exactly the same reason. A value that is simply not
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
- **starting with a letter or digit, or with a single `_`, `-` or `.` bound directly to one**,
- and otherwise letters, combining marks, digits, spaces, dots, underscores and hyphens only
  (letters and digits of any script, so `"Rapport Financier.pdf"` is honoured whole).

The leading-character rule admits a real file name that starts with punctuation, so
`"_internal draft.pdf"`, `` `-notes final.pdf` `` and `".hidden report.pdf"` are all read
whole. The punctuation must be bound to the letter or digit that follows it: one mark, no
space after it. A mark followed by a space is prose decoration rather than part of a name, so
a quoted list bullet (`"- report.pdf"`) or an elision (`"... report.pdf"`) still fails the
shape check, and the real bare name inside it is what gets read - which is the intended
outcome there.

**Quoting does not rescue a name containing any other character** (an apostrophe, `&`, comma,
colon, parenthesis, `+`, `/`, ...) nor one over the word limit. A quoted name rejected for one
of those reasons falls through to be matched exactly like an unquoted one, and the result is
not one single predictable fallback:

- It can be **dropped entirely**: `Report (final).pdf` (quoted or not) matches nothing at all,
  because the parenthesis breaks the allowed-character run on both sides. `"Report+Final.pdf"`
  is dropped too, and for the other reason - the `+` is an identifier continuation, so the
  name never stands as its own token and no fragment survives. A real citation that was the
  only one in the text then reports `total: 0`.
- It can be **read as the fragment that follows the last boundary**, which is not the same as
  "the last space-free segment": `"Report: Final.pdf"` reads as `Final.pdf` and
  `"R&D summary.pdf"` as `summary.pdf`. Both are cut at the **space**, not at the `:` or the
  `&` - those two characters continue an identifier and would silence the name outright if no
  space followed them. The fragment only *looks* like "the last word" by coincidence.
- The word limit fails the same way and is easy to hit with a real file name:
  `"Q3 Financial Results Final Draft.pdf"` is five words, so it is rejected and read as
  `Draft.pdf`.

**The character limit does NOT fail that way.** A quoted name that is name-shaped and within
the 4-word limit but longer than 80 characters emits **nothing at all** - no citation in any
status, `total` unchanged. The two limits are treated differently on purpose: five words of
letters and spaces is indistinguishable from an ordinary quoted sentence, so suppressing it
would silence the real name inside every prose quotation, while four words cannot fill 80
characters of ordinary prose, so a span that long is one very long file name and its tail must
not be checked as a different document.

No such outcome produces a false `resolved` on its own, but a real citation to such a name can
go silently unverified with no trace in `details` (the drop and character-limit cases) or get
checked against a wrong, often unrecognizable document (the fragment case). Check `title` on a
`resolved` verdict, and `total` for an unexpected drop, to catch either.

Single quotes are **not** a delimiter, deliberately: ordinary apostrophes in prose ("don't",
"the team's") would otherwise be misread as opening a document name.

That does **not** mean a single-quoted name is ignored. A single quote is an ordinary
boundary character, so `'report.pdf'` is extracted and checked exactly as the bare name would
be - the quotes simply do no work. The damage is on a name with spaces: `'Annual Report.pdf'`
is read as `Report.pdf`, a **different** document, which is then checked for real and comes
back `unresolved` on a citation whose source may well exist. This is the fragment path in its
most damaging form, and the only fix is the delimiter the grammar does honour: double quotes
or backticks.

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
  allows, or on a different line, or naming its own document (dropped rather than bound to
  the preceding name).
- A page range joined by an em dash character, the word "through", or anything other than a
  hyphen, en dash or "to" - truncated to its first page rather than dropped.
- A document name with spaces, unquoted, or quoted but failing the file-name shape check -
  dropped entirely, or read as a shorter fragment when the shape check failed on a character
  or on the word limit. Over the character limit within 4 words it is dropped, never read as a
  fragment.
- A **bare** document name in a script that does not separate words with spaces, and a
  Latin-script name written directly against such text with no space between them.
- A name touching `/`, `:`, `%`, `+`, `@`, `#`, `=`, `&`, `\` or a format control character -
  it is not a standalone token (`sub/chapter.pdf`, `ns:chapter.pdf`, `report+final.pdf`).
- A bare `node_id` with no document in its sentence, or a bracket tag whose value does not name
  a document as a standalone token - both are extracted, but always `unchecked`. So is
  `node_id:<name>.pdf` or `[node:<name>.pdf]` written with no space after the colon.
- A bracket tag whose value contains a nested `[` - not reported at all, in any status (a
  `<name>.pdf` inside it still is).
- A bracket-tag value containing `://`, as an id (a standalone `<name>.pdf` elsewhere in the
  same brackets still is).
- A document match that is a URL's own path segment, and a scheme-relative or bare-host URL
  path segment (silenced by the standalone-token rule instead).

Single quotes are a special case that does **not** belong on this list: `'report.pdf'` **is**
recognized and checked, and `'Annual Report.pdf'` is read as the different document
`Report.pdf`. See [Quoted names](#quoted-names).

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
- A page can still bind to the document on its **left** when its real owner is named beyond
  what the owner rule reads: past a fourth connecting word, past punctuation, past a line
  break that comes before the connecting words, or written so that the grammar cannot see it
  as a document at all (`__results.pdf__`, `sub/results.pdf`). This is the one over-reach that
  can produce a false `unresolved` carrying a **non-null `title`** on a correct citation, the
  signal that means "the document is real, fix the page". Keeping a page adjacent to the name
  it belongs to (`results.pdf p.12`) avoids it entirely; see
  [A page phrase that names its own document binds to neither](#a-page-phrase-that-names-its-own-document-binds-to-neither).

### Under-reach: a real citation not reported at all

- A citation glued to a preceding URL by `,`, `;`, `(` or `)` is read as part of that URL and
  is **dropped in every status**: absent from `details`, uncounted in `total`, which is
  indistinguishable from there being nothing to check.
- A name touching `/`, `:`, `%`, `+`, `@`, `#`, `=`, `&`, `\` or a format control character is
  not a standalone token and is silent in the same way: `sub/chapter.pdf`, `ns:chapter.pdf`,
  `report+final.pdf`. This is also what silences a scheme-relative (`//example.com/doc.pdf`)
  or bare-host (`example.com/doc.pdf`) URL path segment. The trade is deliberate: cutting the
  name at the glue character and checking the surviving fragment would report a document the
  author never wrote, and a false `unresolved` deletes correct work while a silence does not.
- A bare document name in a script that does not separate words with spaces is not extracted
  at all; quote it to have it checked. A Latin-script name written directly against such text
  is silent for the same reason, and cannot be separated from it.
- `node_id:<name>.pdf` and `[node:<name>.pdf]` written with no space after the colon report an
  `unchecked` node id instead of checking the document. Not a silence, and not dangerous - an
  `unchecked` citation is never deleted - but the document goes unverified.
- A document name with spaces that fails the quoted shape check on a character or on the word
  limit is either dropped entirely or read as a shorter fragment, and the fragment is checked
  as a different document. A single-quoted name with spaces (`'Annual Report.pdf'`) is the same
  failure with a more plausible-looking cause. Failing on the character limit alone is a plain
  drop, never a fragment.
- A page marker on a different line from its document, or separated from it by more prose than
  the closed connector list allows, is not read as a page - the document alone is checked and
  the page claim goes unverified.
- A page phrase that names its own document (`page 12 of results.pdf`) is dropped rather than
  bound, so both documents are checked and the page claim goes unverified. That is the safe
  half of a trade whose other half was a false `unresolved` on the document to its left. The
  same rule drops a page that would have bound correctly whenever a second document follows
  it separated only by dashes, brackets or up to three words (`methods.pdf p.3 ->
  results.pdf p.7`, `methods.pdf p.3 (see results.pdf)`).

- The list separators `and` and `or` are English, and no other language's coordinator is
  recognized. Measured: `a.pdf p.3 and b.pdf p.7` keeps both pages, while
  `a.pdf p.3 oraz b.pdf p.7` reports `a.pdf` with no page at all, and `i`, `lub`, `und`, `y`
  and `et` behave the same way. The probe cannot tell a coordinator it does not know from a
  word introducing the page's own document, so it drops the page rather than binding it to the
  wrong one - the safe direction, but the citation still reports `resolved` with a page nobody
  checked. A comma, a semicolon or a sentence break separates two citations correctly in any
  language (`a.pdf p.3, b.pdf p.7`); prefer them to a conjunction outside English.

  Extending the list is NOT a free fix, which is why it has not been done. Adding a word makes
  the probe stop and bind the page LEFT, and that is the dangerous direction (a false
  `unresolved` carrying a non-null `title`). The short coordinators collide across languages -
  Italian `i` is a definite article, so `page 12 i libri.pdf` names an owner rather than
  coordinating a list, and binding left there would corrupt a correct citation. Trading a
  recoverable silence for that is the one move this grammar's allowlist direction forbids.

The connector-word list (`on`, `at`, `see`), the quoted-name shape limits and the bracket-tag
keyword acceptance are fixed choices made without corpus evidence of what real agents write.
They may need revisiting.

## Changing the grammar

The disclosed behaviour above is pinned in four places at once: `src/grammar.ts`, the tool
description in `src/server.ts`, the [README](../README.md), and this document.
`test/server.test.ts` asserts that the tool description and both prose files still make the
same claims, so a grammar change means updating all four together.
