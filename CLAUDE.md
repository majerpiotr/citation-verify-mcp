# citation-verify-mcp - project instructions

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
  before assuming the grammar is useful in practice.
- `docs/design.md` - the approved design, since revised against those findings.
- `docs/rework-plan.md` - the rework the findings forced. Supersedes
  `docs/implementation-plan.md` (the original task-by-task plan) where they conflict.

## Hard rules

1. **Host-agnostic. No references to any specific consuming host.** This is a standalone
   product, not part of anyone's app. Never mention a particular host application,
   its domain, its agents, or its repo in code, comments, docs, commits, or tests. Test
   fixtures use neutral names (`real-doc`, `some-doc-id-123`), never domain-specific ones.
2. **`key.txt` holds a live PageIndex API key. Never print, echo, `cat`, copy, or commit
   it, and never paste its value into code, docs, logs, or chat.** It is gitignored; keep
   it that way. When a command needs it, pass it by substitution so the value never
   appears in the command text or output:
   `PAGEINDEX_API_KEY="$(cat key.txt)" npx vitest run test/integration.test.ts`
3. **Scope discipline (v0 = existence-only).** Do not add: database or any persistence,
   caching, gateway/post-processing pass, reuse detection, quote-overlap, grounding/NLI,
   confidence scores, self-correction loops. They are deliberately deferred
   (`docs/design.md` section 12). If a task seems to need one, stop and ask.
4. **Invariant: `unresolved` vs `unchecked`.** `unresolved` means checked against the
   corpus and not found. `unchecked` means the check could not run (missing key, timeout,
   backend down). A backend failure must NEVER be reported as `unresolved` - otherwise a
   consuming agent deletes good citations during an outage. There is a test for this;
   never weaken it.
5. **Git hygiene.** Always `git add <explicit paths>`, never `git add .` or `git add -A`.
   Before every commit, confirm no secret is staged. There is no remote; never add one or
   push without being asked.
6. **English for all artifacts** (code, comments, docs, commit messages, tests).

## Execution protocol

Work through `docs/implementation-plan.md` task by task, in order. Each task is TDD:
write the failing test, run it and see it fail, write the minimal implementation, run it
and see it pass, commit. Do not skip the "see it fail" step - it is what proves the test
is real. Mark checkboxes (`- [ ]` -> `- [x]`) as steps complete.

Per-task commits are pre-authorized by the approved plan. Anything beyond the plan's
scope is not - ask first.

Never claim a task is done without having run the tests and seen them pass. Paste the
actual result; do not assert success from expectation.

## Current state

- Git: branch `feature/citation-verify-core`, ~50 commits, no remote, nothing merged.
- Node v24 present (>= 20 required). Dependencies installed. TypeScript 7.
- The unit suite is fully offline and green; it builds against fake `DocLookup` and
  `ToolCaller` implementations, so it needs no API key and no network.
- `test/integration.test.ts` is credential-gated and skips cleanly without env. It has
  been RUN against the live backend and passes, including the outage invariant.
- **Both spikes are DONE.** Their findings drove a rewrite of the client, the grammar,
  the resolver and the tool description. Do not treat the original
  `docs/implementation-plan.md` code blocks as current - several of them contain defects
  that were found and fixed.

Settled facts you must not re-derive or contradict:

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

Known limits, deliberately carried (see `.superpowers/sdd/implementation-plan/progress.md`
for the full ledger and every operator ruling):

- Spike A found that in the one real consuming application investigated, the citation
  format its agents were instructed to use appeared ZERO times in real output, and what
  they did emit named nothing the backend could look up. `total: 0` on text full of
  unverifiable claims is a routine outcome. Both the README and the tool description say
  so; do not quietly soften that.
- Grammar over-reach still produces a false `unresolved` on some non-citations, and
  under-reach still misses some real ones. A citation glued to a preceding URL by `,`, `;`,
  `(` or `)` is silently dropped in every status (a ruled-on trade-off: a false
  `unresolved` on a valid external link is worse than a silence). Each case is disclosed in
  the tool description and the README. **If you change the grammar, update both.**
  `test/server.test.ts` pins the tool description clause by clause, and its
  "README states the load-bearing claims the tool description states" block pins the
  README's half of the same claims - substance only, whitespace-normalized, so re-wrapping
  a paragraph is fine and deleting a claim is not. Neither block is exhaustive: a claim you
  add is only guarded once you add the assertion with it.
- No per-call timeout budget across a whole draft; the SDK's 60s per-request default is
  the only bound, and `verifyCitations` is sequential, so the bound multiplies by the
  number of distinct documents (disclosed in the README's known limits).
  `PAGEINDEX_FOLDER_ID` is not implemented.
- `package.json` declares `"license": "MIT"` but there is no `LICENSE` file in the repo,
  and `"files": ["dist"]` would not ship one. Unresolved; the owner's call.

## Commands

```bash
npm install                       # once, after Task 1 creates package.json
npm test                          # full unit suite (offline)
npx vitest run test/<file>.test.ts  # single test file
npm run build                     # tsc -> dist/
```
