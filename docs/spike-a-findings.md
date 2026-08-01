# Spike A findings - citation shapes emitted by a real consuming application

> Status: complete. Investigated one real, currently-inactive multi-agent application that
> uses the same document backend (PageIndex) this tool targets. Read-only investigation;
> nothing in that application's repository was modified.

## What was investigated

A multi-agent application (source available for read-only inspection, not part of this
project) in which many distinct agent roles each generate free-text analysis and are
instructed to cite supporting source documents. The corpus is a set of PDFs uploaded to
PageIndex. The investigation covered:

- Every agent role's instruction file (system prompt / style guide), searched for citation
  format requirements, few-shot examples, and output-format specifications.
- The application's own document-upload / ingest script, to see how documents are actually
  named and identified in PageIndex (the file name it uploads under, versus any internal
  slug or database key it keeps for itself).
- The application's own citation-parsing code (its front-end renderer and a Python
  "citation validator" module), which independently confirm what shape the application
  itself expects to parse back out of agent output.
- One saved, real generated transcript from a full run of the system (used as a fallback
  demo fixture), searched exhaustively for every citation-shaped substring.
- The application's own internal analysis notes, which happened to already contain a
  citation-shape audit of that same transcript, done for an unrelated purpose. Its findings
  are consistent with, and corroborate, what this investigation found independently.

No live generation was triggered; nothing was run. The one transcript available is real
model output, not hand-written, but it is a single sample from one topic.

## Shapes found

### Shape 1: bracketed tag citation, e.g. `[node:some-doc-id-123]`

**What it is.** Every one of the ~25 agent instruction files mandates this as *the*
citation format: a literal `[node:` prefix, an identifier, a closing `]`. Instruction text
is uniform across all of them ("cite at least one ... node in the format `[node:<node_id>]`"),
and a few files give concrete examples such as `[node:some-doc-id-123]` and
`[node:another-example-42]` (values changed here; the real ones are short kebab-case slugs
that read like human-invented mnemonic labels, not backend-issued ids).

**How often.** This is the *instructed* format in 100% of the citing agent roles - the
single, unambiguous, uniformly-worded convention every agent is told to use. It is also
what the application's own front-end and its own transcript-parsing code look for
(`/\[node:([^\]]+)\]/g` appears verbatim in two independent places in that codebase), so it
is clearly the format the application's builders intended and built tooling around.

**Actually observed in real output: zero times.** The one real saved transcript available
(40,506 characters, a complete run covering multiple agent roles across several output
sections) contains this pattern **zero times**. Every agent role's instructions mandate it;
none of them followed it in the one sample available. This is corroborated by the
application's own internal notes, which independently ran the same search and reported the
same zero count, plus the observation that the transcript's grounding instead takes the
form of inline quotes copied from the instruction files themselves rather than anything
retrieved from the corpus.

**Grammar coverage: not recognized, at all.** `src/grammar.ts`'s `RE_NODE_ID` matches only
literal `node_id` (with an underscore) followed by `:` or `=`, e.g. `node_id: abc-123`. It
has no rule for a `[` `word` `:` `value` `]` bracket-tag shape, and no rule for the word
`node` without the `_id` suffix. `RE_DOC` and the quoted-name patterns require a `.pdf`
extension immediately in the match, which a slug like `some-doc-id-123` inside brackets
never has. So a citation in this shape is invisible to every pattern in the grammar - it
does not partially match and get misread; it is not matched by anything at all.

**Consequence.** This is the "not extracted at all" failure mode the grammar's own header
comments warn about: the citation never appears in `verify_citations`'s output in any
form - not `resolved`, not `unresolved`, not `unchecked`. It is simply absent, which reads
to a consuming agent (and to a human reviewing the tool's output) as if nothing was cited
there worth checking, or as silent endorsement of whatever was written. Per this tool's own
citation model (a bare id with no document name is unverifiable by construction and must be
`unchecked`, never silently dropped), the correct behavior for a bracket-tag id with no
document name attached would be to surface it as `unchecked` - visibly flagged as
unverifiable - not to make it vanish.

### Shape 2: free-text references to a source title, with no resolvable identifier at all

**What it is.** In the one real transcript, every actual citation-like statement takes the
form of ordinary prose naming a source by its human-readable title and a subdivision of it,
with no file name, no node id, and no page number: the shape is "<subdivision> <number> of
the <Source Title>", where the source title is a display name a person would recognize.
These read as authoritative references to a human, but none of them names anything that
corresponds to a document as PageIndex would look it up (PageIndex's lookup key is a
literal uploaded file name, per `docs/spike-b-findings.md` section 4; the source names
appearing in this prose are display titles, not file names, and no file-name-shaped or
node-id-shaped token appears anywhere near them).

**How often.** This is effectively 100% of the citation-shaped content actually present in
the one real transcript - roughly two to three dozen instances by rough count, versus zero
of the instructed bracket-tag shape.

**Grammar coverage: not applicable, not a gap.** Nothing in this shape could be recognized
by a document-existence-checking grammar regardless of how the regex were tuned, because
nothing in it names an uploaded document by any identifier the backend accepts. There is no
missing pattern to add here; the gap is upstream of extraction; it is that the actual text
produced does not name a checkable source at all.

**Consequence.** None specifically attributable to the grammar. But this is the sharpest
finding in this investigation: it is a direct, real-world instance of the risk
`docs/design.md` section 11 (R1) already names as "risk #1 for the whole premise" - an
agent that cites free text instead of a resolvable token leaves nothing for this tool to
verify, no matter how complete the grammar is.

### Shape 3: `[Source: <url>]` - a different citation family entirely

**What it is.** One agent role in this application (a role that researches external sources, distinct from the
corpus-citing roles above) is instructed to cite external web sources, not the document
corpus, using its own bracket-tag convention: `[Source: <url>]`, explicitly described in
that role's own instructions as "the web analogue of PageIndex node citations."

**How often.** Instructed for 1 of ~25 agent roles. No real output sample from that specific
role was available to confirm actual usage.

**Grammar coverage: out of scope by design, not a gap.** This shape cites a URL, not a
PageIndex document. It is not something a document-existence checker against PageIndex
should resolve, and treating it as in-scope would exceed this tool's stated purpose. Noted
here only because it is further evidence that a single consuming application can carry more
than one citation convention simultaneously, invented independently by whoever wrote each
agent's instructions.

### Shape 4: the backend's real lookup key, as this application actually populates it

**What it is.** Not an emitted citation shape, but a relevant fact about document identity
in this application: its own ingest script uploads each PDF under a file name derived from
an internal slug plus `.pdf`, e.g. (shape only) `report-2024-12-345.pdf`. That internal
slug is the application's own bookkeeping key (stored in its own manifest alongside a
separate, opaque id PageIndex itself assigns) - it is never shown to the citing agents, and
none of the citing agents' instructions or the one real transcript ever reference it. The
bracket-tag ids from Shape 1 (when they appear in instruction examples) are different
strings, invented independently, that do not correspond to any real file name or to the
backend's actual `node_id` ordinals (which per `docs/spike-b-findings.md` section 6 are
small per-document ordinals like `0000`, not descriptive slugs).

**Grammar coverage.** If this file-name shape were ever cited literally as prose (it was
not observed to be), `RE_DOC`'s `<name>.pdf` pattern would recognize it correctly - hyphens,
digits, and multiple dot-segments are all within what `DOC_NAME_PATTERN` already accepts.
This is the one shape in this investigation the grammar already handles correctly, but it
is also the one shape that was never actually seen.

## Coverage summary

| Shape | Instructed | Actually observed | Recognized by current grammar |
|---|---|---|---|
| `[node:<slug>]` bracket tag | 100% of corpus-citing roles | 0 (in the one real sample) | No - matches nothing in `grammar.ts` |
| Free-text section reference, no identifier | Not instructed (agents are told to use the bracket tag) | ~100% of actual citation-shaped content | Not applicable - no identifier exists to extract |
| `[Source: <url>]` | 1 of ~25 roles | Not observed (no sample) | Out of scope by design (not a PageIndex document) |
| Real backend file name (`<slug>.pdf`) | Never instructed | Never observed | Yes, if it appeared |

Of the four distinct shapes found, the current grammar recognizes exactly one - and that
one was never actually seen in the one real output sample available. Both shapes that were
actually observed in real output (the bracket tag, and free-text section references) go
completely unrecognized, for two structurally different reasons: one is a syntax the
grammar has no rule for, the other names nothing the backend could look up regardless of
syntax.

## Prioritized recommendations

1. **Recognize a generic bracket-tag id shape, e.g. `[node:<id>]` / `[<word>:<id>]`, and
   route a bare id with no accompanying document name to `unchecked` rather than dropping
   it silently.** This is the highest-value, lowest-risk change: it is the single most
   consistently instructed format across this application's ~25 agent roles, costs nothing
   in false-positive risk (per the tool's own citation model, an id with no document is
   already defined as `unchecked`, never `unresolved`), and turns a currently-total blind
   spot into at least a visible, correctly-labeled "could not verify." It would not, by
   itself, make anything newly resolvable, since these ids do not correspond to real
   backend node ids or file names either - but visibility beats silence, which is the
   grammar's own stated design principle elsewhere.
2. **Do not treat "add more regex patterns" as sufficient.** The dominant real-world gap
   found here (Shape 2) is not a syntax the grammar failed to anticipate - it is agent
   output that names no checkable identifier at all, confirming design.md's R1 as a live
   risk rather than a theoretical one. The mitigation available to this project is exactly
   what design.md already names: host-side instruction pressure demanding a resolvable
   token, not a grammar change. This spike's evidence is a concrete argument for
   prioritizing that guidance work (e.g., a strongly worded tool description, or example
   citation formats surfaced to the consuming agent) alongside any grammar update.
2b. **If a bracket-tag pattern is added, keep the keyword generic rather than hardcoding
   a single literal like `node`.** This application alone independently invented two
   different bracket-tag conventions (`node:` and `Source:`) for two different citation
   families. A future host is likely to invent a third word. A configurable or
   multi-keyword-aware pattern is more durable than chasing individual literals one at a
   time - though widening this responsibly (without opening a false-positive path) is a
   design decision, not a mechanical regex edit, and should be scoped as its own task.
3. **Lower priority: no action needed for the URL-citation shape.** It is a different
   citation family (external web sources) that this tool should not attempt to resolve
   against PageIndex; it is out of scope by the tool's own stated purpose, not a gap.

## Limits of this evidence

- **One real transcript.** All "actually observed" claims rest on a single saved run, one
  topic, one pass through the system. It is genuine model output, not synthetic or
  hand-edited (confirmed by cross-checking the application's own internal notes, which
  independently reached the same zero-count finding), but a sample size of one cannot
  establish a reliable frequency distribution, only that the instructed format was not
  used at all in this instance and that unstructured references were used instead.
- **No sample for the URL-citing role.** Shape 3 is confirmed only from instructions, never
  from real output, so its actual real-world shape (or whether it is used at all) is
  unknown.
- **No visibility into a live or in-progress run.** The application currently appears
  inactive (no live database of past sessions was found); everything here comes from
  static instruction files, ingest scripts, and the one archived transcript. Whether newer
  or different runs would show the bracket-tag format actually being followed is unknown.
- **This is one application, not a survey.** These findings describe what one real
  consuming system does, not a general law about what "consuming agents" do. They are best
  read as concrete counter-evidence against assuming agents reliably follow an instructed
  citation format, not as a definitive catalog of every shape this tool will ever need to
  recognize.
- **The instructed format's id values were only seen inside instruction-file examples,
  never inside real output**, so the true distribution of real id shapes under that
  convention (length, character set, whether they ever resemble real backend node ids)
  remains unconfirmed - only the bracket-tag syntax itself is well evidenced, not the
  content that would fill it in a larger sample.
