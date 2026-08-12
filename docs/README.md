# Documentation index

Two audiences read this folder, and most of it is not written for the first one.

**Using the server?** You need [`../README.md`](../README.md), and then at most two files here.
Everything else is the project's working record: why the code is the way it is, kept because the
code comments cite it, not because it is worth your time.

**Note:** the npm package ships `dist/`, `README.md`, `LICENSE`, and exactly the two files in
the first table below - the ones the README sends you to read. Nothing else here is in the
tarball, which is why a link to any of it from the README must be an absolute URL rather than
a relative path (`test/toolchain.test.ts` enforces that).

---

## If you use this server

| Document | What it is |
| --- | --- |
| [`citation-grammar.md`](citation-grammar.md) | The exhaustive reference for what counts as a citation, and every case where the grammar over-reaches or under-reaches. The README summarises it; this states it in full. Read it before relying on a citation shape. |
| [`integration-guide.md`](integration-guide.md) | What registering the server does not tell you. Measured against a running multi-agent system: the things that decide whether verification actually happens, several of which fail silently. Read it before wiring the tool into an agent. |

## If you work on this server

Read these in the order given. `CLAUDE.md` at the repository root is the entry point and states
the hard rules; these are its evidence.

| Document | Standing |
| --- | --- |
| [`spike-b-findings.md`](spike-b-findings.md) | **Ground truth.** The observed behaviour of the PageIndex backend, probed live with a real key. It supersedes any document that disagrees with it, including this one. Cited from seven files. |
| [`spike-a-findings.md`](spike-a-findings.md) | What a real consuming application actually emitted. The source of the README's headline caveat: a transcript full of confident argument can contain nothing checkable. Its measurements stand; its present-tense claims about the grammar are historical. |
| [`design.md`](design.md) | The approved design, since revised against both spikes. |
| [`rework-plan.md`](rework-plan.md) | Superseded as a plan, but still cited by name from the code and tests as the source of specific rules. Carries a status banner. |

## Historical record

[`history/`](history/) holds documents that are finished and are kept only so the reasoning
behind load-bearing decisions stays findable. Every one carries a banner saying so. **Do not
implement from them and do not cite them as current behaviour.**

| Document | Why it is still here |
| --- | --- |
| [`history/implementation-plan.md`](history/implementation-plan.md) | The original task-by-task build plan. |
| [`history/code-review-round-2.md`](history/code-review-round-2.md) | Round 2 audit. Its findings were fixed before round 3 ran. |
| [`history/code-review-round-3.md`](history/code-review-round-3.md) | Round 3 audit, the full pre-publication pass. All fifteen code findings are fixed. About two dozen code comments cite it by round and finding number (`round-3 review, P0-2`), which is why deleting it would leave those comments pointing at nothing. |
