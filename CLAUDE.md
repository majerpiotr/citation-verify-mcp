# citation-verify-mcp - project instructions

Guidance for anyone working on this repository, human or agent. For how to *use* the
server, read `README.md` instead.

## What this is

A standalone, pluggable MCP server exposing one tool, `verify_citations`. It takes an
agent's draft text, extracts citation tokens, and deterministically checks whether each
one resolves against PageIndex. Existence is verified by code calling the source of
truth - never by asking a model, because a model-based checker can hallucinate exactly
like the one it checks.

Authoritative documents, read before starting work, in this order:
- `docs/spike-b-findings.md` - the OBSERVED behaviour of the backend, from probing the
  live service. Ground truth; it supersedes any document that disagrees with it.
- `docs/spike-a-findings.md` - what a real consuming application actually emits. Read it
  before assuming the grammar is useful in practice. Its measurements stand; its
  present-tense claims about the grammar are historical (see its banner).
- `docs/design.md` - the approved design, since revised against those findings.
- `docs/citation-grammar.md` - the published, exhaustive grammar reference. It is a
  USER-FACING surface, not background: several disclosed limits live only there, and
  `test/server.test.ts` pins them against it. Read it before changing `src/grammar.ts`.
- `docs/rework-plan.md` and `docs/implementation-plan.md` - historical build records.
  Both carry SUPERSEDED banners. Do not implement from them or cite them as current
  behaviour.

## Hard rules

1. **Host-agnostic. No references to any specific consuming host.** This is a standalone
   product, not part of anyone's app. Never mention a particular host application,
   its domain, its agents, or its repo in code, comments, docs, commits, or tests. Test
   fixtures use neutral names (`real-doc`, `some-doc-id-123`), never domain-specific ones.
2. **Never commit, print, or paste an API key.** `key.txt` is gitignored and is the
   conventional place to keep one locally; keep it that way. Never `cat`, echo, copy, or
   log its contents, and never paste a key into code, docs, tests, logs, or a chat
   transcript. When a command needs one, pass it by substitution so the value never
   appears in the command text or its output:
   `PAGEINDEX_API_KEY="$(cat key.txt)" npx vitest run test/integration.test.ts`
3. **Scope discipline (v0 = existence-only).** Do not add: database or any persistence,
   caching, gateway/post-processing pass, reuse detection, quote-overlap, grounding/NLI,
   confidence scores, self-correction loops. They are deliberately deferred
   (`docs/design.md` section 12). If a task seems to need one, stop and ask.
4. **Invariant: `unresolved` vs `unchecked`.** `unresolved` means checked against the
   corpus and not found. `unchecked` means the check could not run (timeout, backend down,
   credential rejected, unreadable response, or a citation unverifiable by construction -
   NOT a missing key, which makes `src/index.ts` refuse to start, so no tool call happens).
   A backend failure must NEVER be reported as `unresolved` - otherwise a
   consuming agent deletes good citations during an outage. There is a test for this;
   never weaken it.
   Companion invariant on the same field set: **`title` is non-null if and only if the
   backend positively confirmed the cited document exists**, on any status. It is the
   machine-readable delete-versus-fix signal, so an `unresolved` on a real document cited
   with a bad page or node must keep carrying its real name.
5. **Git hygiene.** Always `git add <explicit paths>`, never `git add .` or `git add -A`.
   Before every commit, confirm no secret is staged. Never force-push and never rewrite
   published history.
6. **English for all artifacts** (code, comments, docs, commit messages, tests).

## How to work on this

Every change is TDD: write the failing test, run it and SEE IT FAIL, write the minimal
implementation, run it and see it pass, commit. Do not skip the see-it-fail step - it is
what proves the test is real. This project has repeatedly found tests that could not
fail; if a test guards a load-bearing claim, mutate the implementation and confirm the
test goes red.

Never claim work is done without having run the tests and seen them pass. Paste the
actual result; do not assert success from expectation.

Keep commits scoped to one defect or one feature, with an explicit path list.

## Settled facts you must not re-derive or contradict

- The transport is an HTTP MCP endpoint, `https://api.pageindex.ai/mcp`, authenticated
  with `Authorization: Bearer <key>`. There is NO child process. The published
  `pageindex-mcp` package is OAuth-only and never reads `PAGEINDEX_API_KEY`.
- The lookup argument is `doc_name` - a file name including its extension, matched
  case-sensitively. `doc_id` is rejected.
- A MISSING document arrives as `isError: true`, the same channel as a backend failure.
  The only thing separating them is `errorCode: "NOT_FOUND"` in the parsed body.
  `unresolved` requires that positive code; every other ambiguity throws and becomes
  `unchecked`.
- `node_id` identifies a node inside ONE document's tree, not a document. A bare node id
  is unverifiable by construction and must be `unchecked`.
- The key carries `remove_document` capability on the same connection. This server calls
  only read tools.

## Known limits, deliberately carried

- Spike A found that in the one real consuming application investigated, the citation
  format its agents were instructed to use appeared ZERO times in real output, and what
  they did emit named nothing the backend could look up. `total: 0` on text full of
  unverifiable claims is a routine outcome. Both the README and the tool description say
  so; do not quietly soften that.
- Grammar over-reach still produces a false `unresolved` on some non-citations, and
  under-reach still misses some real ones. A citation glued to a preceding URL by `,`, `;`,
  `(` or `)` is silently dropped in every status, and so is any name touching `/ : % + @ #
  = & \` or a format control character, or written directly against a script that uses no
  word spaces (the same ruled-on trade-off: a false `unresolved` on a valid citation is
  worse than a silence, and silence is recoverable by quoting). Each case is disclosed in
  THREE user-facing surfaces: the tool description in `src/server.ts`, `README.md`, and
  `docs/citation-grammar.md`. **If you change the grammar, update all three** - several
  limits now live only in the grammar reference, so updating the first two leaves the suite
  red on the third.
  `test/server.test.ts` pins the tool description clause by clause, and its
  "the prose documentation states the load-bearing claims the tool description states"
  block pins the same claims in whichever prose file now carries them - substance only,
  whitespace-normalized, so re-wrapping a paragraph is fine and deleting a claim is not.
  Neither block is exhaustive: a claim you add is only guarded once you add the assertion
  with it. Never delete an assertion to make a move compile - move it to the file the
  content moved to.
- A page phrase that names its own owner (`page 12 of results.pdf`) binds to that owner,
  not to a preceding document. The preposition list is closed at `of` and `in`; other
  prepositions still bind left. Where binding is ambiguous the page is dropped rather
  than attached to the wrong document, because a false `unresolved` is worse than a
  silence.
- No per-call timeout budget across a whole draft; the SDK's 60s per-request default is
  the only bound, and `verifyCitations` is sequential, so the bound multiplies by the
  number of distinct documents (disclosed in the README's known limits).
  `PAGEINDEX_FOLDER_ID` is not implemented.
- The package is NOT published to npm. The README's quick start therefore leads with a
  clone-and-build path and marks the `npx` form as post-publication. Do not present the
  `npx` form as working today.
- A failed lookup writes one redacted, control-character-free, 400-char-capped line to
  stderr (`logLookupFailure` in `src/resolver.ts`). stdout is the MCP protocol stream and
  must never be written to (`test/stdout-safety.test.ts`).

## Environment

- The runtime floor is Node 20 (`engines`), verified by running the built server there.
- The DEVELOPMENT floor is higher: Node 20.19.0, set by rolldown's declared range
  (`^20.19.0 || >=22.12.0`). Below it npm skips rolldown's native binding as
  engine-incompatible and `npm test` fails with `Cannot find native binding`. This is a
  tooling limit, not a runtime one, and it is platform-dependent: an older 20.x can pass
  on macOS arm64 and still fail on Linux, so trust the declared range over a local green
  run.
- `test/integration.test.ts` is credential-gated and skips cleanly without env. It needs
  BOTH `PAGEINDEX_API_KEY` and `CITATION_VERIFY_TEST_DOC_NAME` (plus
  `CITATION_VERIFY_TEST_NODE_ID` for the node assertion); with only the key it reports a
  clean skip that looks like a pass.
- The unit suite is fully offline: it builds against fake `DocLookup` and `ToolCaller`
  implementations, so it needs no API key and no network.

## Commands

```bash
npm install                         # install dependencies (also builds, via `prepare`)
npm test                            # full unit suite (offline)
npx vitest run test/<file>.test.ts  # single test file
npm run typecheck                   # tsc --noEmit
npm run build                       # clean + tsc -> dist/
```
