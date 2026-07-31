# citation-verify-mcp - project instructions

## What this is

A standalone, pluggable MCP server exposing one tool, `verify_citations`. It takes an
agent's draft text, extracts citation tokens, and deterministically checks whether each
one resolves against PageIndex. Existence is verified by code calling the source of
truth - never by asking a model, because a model-based checker can hallucinate exactly
like the one it checks.

Authoritative documents, read both before starting work:
- `docs/design.md` - the approved design (architecture, constraints, scope).
- `docs/implementation-plan.md` - the task-by-task implementation plan.

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

- Git: branch `feature/citation-verify-core`, with commits. No remote.
- Node v24 present (plan requires >= 20). Dependencies installed.
- Tasks 1-6 are complete and reviewed: grammar, PageIndex client, resolver, MCP server
  surface, binary entry point, plus the fixes from a whole-branch review. The unit suite
  is fully offline - it builds against a fake `DocLookup`, so it needs no API key and no
  network.
- Task 7 (integration test) and Task 8 (README) have NOT been run, and neither spike has.
  Spike A needs representative outputs from an external consuming system, which this repo
  cannot produce. Spike B and Task 7 need a live API key and network, which the operator
  withheld. Their checkboxes in `docs/implementation-plan.md` are deliberately unticked
  and each carries a note recording why.
- Consequence to respect: the `get_document` argument shape and the real
  found-vs-not-found discriminator are still unconfirmed (Spike B). Do not guess at them.

## Commands

```bash
npm install                       # once, after Task 1 creates package.json
npm test                          # full unit suite (offline)
npx vitest run test/<file>.test.ts  # single test file
npm run build                     # tsc -> dist/
```
