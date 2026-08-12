# Code review: round 3 (full audit before v1.0 / GitHub publication)

> **HISTORICAL RECORD - do not implement from this document.** Every code finding below
> (P0-1 through P0-4, P1-1 through P1-3, P2-1 through P2-5) was fixed on this branch, each
> with a failing test written first and its own commit; the suite went from 458 to 521
> passing. The "Release readiness" checklist at the end is the only part that may still have
> open items. It is kept for the reasoning behind guards that are now load-bearing, not as a
> description of outstanding work. For current behaviour read `CLAUDE.md`, `README.md` and
> `docs/citation-grammar.md`.

**Date:** 2026-08-08
**Scope:** the whole `src/` tree on `feature/citation-verify-core` (~2,600 lines, the
entire branch vs `main`), reviewed by a multi-agent pass: 8 finder angles, 43 raw
candidates, 21 sent to verification, 15 CONFIRMED (14 reproduced by executing the built
code), 1 PLAUSIBLE. This document collects all survivors plus the items cut from the
tool report, prioritized for the v1.0 goal: prove the concept works and publish to
GitHub.

## Verification baseline

- `npm test`: 458 passed, 8 skipped (integration suite skips cleanly without
  credentials).
- `npm run typecheck`: passed.
- `key.txt` confirmed gitignored.

## Priority legend

- **P0 (critical)**: produces a false delete signal on a correct citation or opens a
  security channel. These contradict the project's core invariant (CLAUDE.md hard
  rule 4) and make the tool actively harmful in the exact scenario it exists to
  prevent. Fix before publishing.
- **P1 (priority)**: real defects with concrete reproductions, but the trigger is
  narrower (astral Unicode, hostile input sizes) or the failure is availability rather
  than a wrong verdict. Fix soon; not blockers for concept validation.
- **P2 (nice to have)**: documentation mismatches on the safe side, defense in depth,
  log hygiene, cleanups. No meaningful impact on whether the concept works.

---

## P0 - critical

### P0-1. A self-contradictory not-found body is accepted as a positive absence

`src/pageindex-client.ts:156` - `interpretGetDocument`'s not-found branch reads
`isError: true` + `errorCode: "NOT_FOUND"` as a confirmed absence even when the same
body also carries `success: true` and a document name. Reproduced end to end: the
contradictory body flows to `unresolved` with `title: null` - the delete signal - from
a payload that simultaneously says the document exists. The success branch guards
against the mirror ambiguity (`!isError`); this branch has no symmetric guard. Every
ambiguity must throw to `unchecked` (hard rule 4).

**Fix:** throw (-> `unchecked`) when the not-found body also asserts success or carries
a document payload. Add the missing test for the both-flags combination.

### P0-2. A present but unreadable pagination block silently truncates the node id set

`src/pageindex-client.ts:266` - `shouldFetchNextStructurePart` treats a PRESENT
`pagination` block whose `has_more` is not the literal boolean `true` (e.g. `"true"`,
`1`, or a renamed key) as "last part", so `accumulateNodeIds` returns a partial set
instead of throwing. Reproduced: a real node in part 2 then fails `ids.has(nodeId)` ->
`unresolved` with a NON-NULL title ("document is real, fix the node") on a correct
citation. A backend serializer change fails every node citation in the tail of every
multi-part outline at once, silently. Only an ABSENT pagination block is the observed
"no more parts" shape; present-but-unreadable must throw, consistent with
`getResultEnvelope`.

**Fix:** throw when `pagination` is present and `has_more` is neither absent nor
boolean.

### P0-3. Backend-controlled `similar_files[0]` is interpolated unsanitized into the suggestion

`src/resolver.ts:401` - the `Did you mean "..."?` suggestion embeds
`result.similar[0]` verbatim: validated only as `typeof string`, unbounded, control
characters intact. Reproduced: a 200 KB string containing an instruction-injection
payload, raw newlines, ESC and BEL came back byte-identical in `suggestion`, JSON-
stringified straight into the consuming model's context. Amplification is per
CITATION (the memoized outcome is copied into every citation of the missing doc). A
compromised or misbehaving backend, or an adversarially named corpus file, gets an
unsanitized injection channel into the agent that acts on verdicts - the exact channel
the file's own `DOC_UNCHECKED_SUGGESTION` comment says must stay bounded.

**Fix:** cap the length and flatten control characters (reuse the `oneSafeLine`
approach from the stderr path) before interpolation.

### P0-4. An astral character in a URL un-suppresses its path segment as a citation

`src/grammar.ts:375` - `urlSchemeFlags` tests `RE_URL_RUN_CHAR` against single UTF-16
code units, so any non-BMP character (astral letter, emoji) inside a URL is seen as two
lone surrogates, the URL run breaks, and the URL's own path segment becomes a citable
document. Reproduced: `https://example.com/\u{20BB7},report.pdf` extracts
`report.pdf`, which looks up NOT_FOUND -> `unresolved` with `title: null` -> the
consuming agent is told to delete a valid external reference. This is precisely the
false-unresolved-on-a-URL outcome the sub-delimiter silence exists to prevent
(docs/citation-grammar.md).

**Fix:** iterate code points (or match the surrogate pair) here and in
`pageOwnerFollows` - the only two per-code-unit loops in the file (see P1-2).

---

## P1 - priority

### P1-1. A quoted-only page owner binds the page LEFT instead of being dropped

`src/grammar.ts:496` - `pageOwnerFollows` consults only the `docStarts` mask (populated
by the bare pass) and counts the words of a quoted owner against
`MAX_CONNECTING_WORDS`. A page phrase whose owner is only recognizable via the quoted
pass (no-space-script name, or a 4+ word quoted name) binds LEFT: reproduced,
`methods.pdf, page 12 of "Annual Report Draft Final.pdf"` -> `methods.pdf#p12`. If
`methods.pdf` has under 12 pages the result is `unresolved` with a NON-NULL title on a
correct citation, and the genuine page-12 claim resolves unchecked. Contradicts
docs/citation-grammar.md:151-153, which lists double-quoted names among recognized
owners. The existing test at test/grammar.test.ts:1578 passes only by accident (the
bare pass matches the last word of the quoted owner).

**Fix:** make the owner probe aware of quoted-name starts (or drop the page when a
quote opens inside the connecting window). Fix the accidental test.

### P1-2. An astral character in the connecting phrase makes the page bind to the wrong document

`src/grammar.ts:511` - same code-unit iteration defect as P0-4, in
`pageOwnerFollows`'s three character classes. Reproduced: `methods.pdf, page 12 of
\u{1D42D}he results.pdf` -> `["methods.pdf#p12", "results.pdf"]`, while ASCII and BMP
controls correctly drop the page. Same consequence class as P1-1. Same fix locus as
P0-4; fix both together.

### P1-3. Nothing bounds the tool RESPONSE size: ~40x output amplification with zero backend calls

`src/server.ts:193` - a schema-valid 1 MiB input of repeated `node_id: zN ` yields a
measured 39.5 MB JSON result (66,230 citations x a ~486-char static suggestion) in
67 ms with a 63 MB heap delta, and no lookups run, so neither `MAX_DISTINCT_DOCUMENTS`
nor the abort checks engage. Second unbounded channel at `src/resolver.ts:191`:
`nodeAbsentSuggestion` echoes a draft-supplied node id verbatim (a 500 KB id produced a
1.5 MB result). Cheap for the caller, expensive for the host that buffers tool
results; no constant, test, or disclosure covers it.

**Fix:** cap total citations reported per call (mirror the `MAX_DISTINCT_DOCUMENTS`
pattern: everything past the cap `unchecked` with a "too many citations" suggestion,
shared suggestion strings, truncate echoed ids). Disclose in the three user-facing
surfaces.

---

## P2 - nice to have

### P2-1. Startup stderr path lacks the resolver's log hygiene

`src/index.ts:64` - `describeStartupFailure` -> `exitAfterStderr` redacts the secret
but applies no control-character stripping and no length cap. Reproduced: an error
message with CR/LF, `ESC[2J` and 150 KB of padding rendered 250 KB across 3 stderr
lines, including a forgeable copy of the resolver's own log-line format. Reachable in
practice: the SDK's `StreamableHTTPClientTransport` throws `Error POSTing to endpoint:
${raw response body}` inside `client.connect`, so a backend or proxy controls startup
stderr verbatim. Availability/log-forging only; no wrong verdict.

**Fix:** run the message through a `oneSafeLine` equivalent in (or next to)
`describeStartupFailure`.

### P2-2. Bracket tag with a quoted no-space-script name is emitted as an opaque unchecked id

`src/grammar.ts:915` - the bracket-tag step-aside consults `namesStandaloneDoc`, which
the quoted pass never populates, so `[Source: "REPORTNAME.pdf"]` (no-space-script name)
becomes one `node_id: '"REPORTNAME.pdf"'` citation, `unchecked`, while the same quoted
name in plain prose IS extracted and checked. Safe direction under hard rule 4, but it
silently revokes the documented quote-it-to-have-it-checked remedy inside bracket tags
(the exact "defect 2" the step-aside comment claims to have fixed).

**Fix:** teach the step-aside to recognize quoted names, or disclose the exception in
the three user-facing surfaces.

### P2-3. Structure pages never verify the echoed document name

`src/pageindex-client.ts:292` - `parseStructurePage` does not check the `doc_name` the
observed response carries (spike-b section 5); `assertNameEcho` guards only the
`get_document` path. A structure page for the wrong document would be accepted and a
correct node citation returned `unresolved` with a non-null title. Verified caveat: a
uniformly fuzzy backend trips `assertNameEcho` on `get_document` first, so the harm
requires the backend to match structure lookups more loosely than document lookups.
Defense in depth on the dangerous side of the invariant; cheap since `docName` is
already in scope.

### P2-4. Items cut from the tool report (confirmed, low severity)

- `src/grammar.ts:878` - trailing-punctuation dedupe diverges between bracket tags and
  `node_id:` prose: `[node: 0003.]` vs `node_id: 0003.` yields two citations despite
  the documented dedupe guarantee.
- `src/pageindex-client.ts:445` - an empty-string `PAGEINDEX_BASE_URL` fails startup
  with a bare `Invalid URL`, no variable name in the message.

### P2-5. Verified cleanups (no behaviour change; 206/206 grammar tests pass with the variants)

- `src/grammar.ts:552` - `quotedPageFragment` re-types `quotedNameFragment` verbatim;
  deduplicate.
- `src/grammar.ts:983` - the second `DOC_NAME_PATTERN` scan is skippable and costs
  ~45% of `extractCitations` on the common `total: 0` path.
- The `idSpans`/`quotedSpans` masks are mergeable.
- One mask allocation happens before the early-out and can move after it.

---

## Release readiness for GitHub (separate from code findings)

- [x] `package.json` says `version: 0.0.1`; decide the published version (1.0.0 if the
      concept-validation bar is met, or 0.1.0 to signal pre-stability). **Resolved: 0.1.0.**
- [x] Untracked `probe-p5.mjs`: a measurement script; move to `scripts/` with a
      comment, or delete. **Resolved: kept as `scripts/measure-response-size.mjs`.**
- [x] Untracked `docs/history/code-review-round-2.md`: historical record of round 2 (its P1/P2
      findings are fixed on this branch); commit it as history or delete it. **Resolved: kept
      as history.**
- [ ] `feature/citation-verify-core` is 82 commits ahead of `main` (105 as of this edit);
      merge before publishing. **Decided: fast-forward, so the branch's commits become
      `main`'s history unchanged and no merge commit is created.**
- [x] Repository URL in `package.json` points to `github.com/majerpiotr/...`; confirm
      the account/repo name before pushing. **Resolved: confirmed correct.**
- [ ] Package is intentionally NOT published to npm. The README's quick start now leads with
      the npm form marked unavailable, then a GitHub install that works today. Publishing
      means flipping that marker and the settled fact in `CLAUDE.md` in one commit.

## Suggested order of work

1. P0-1 and P0-2 (same file, same invariant, small guards + tests).
2. P0-3 (sanitize the suggestion channel).
3. P0-4 + P1-2 together (one code-point iteration fix, two call sites).
4. P1-1 (quoted owner probe) - touches the grammar and one accidental test.
5. P1-3 (response cap) - needs a disclosed constant and updates to the three
   user-facing surfaces.
6. P2 items as time permits; none block publication.

Every fix per project rules: failing test first, see it fail, minimal implementation,
see it pass, one commit per defect with explicit paths.
