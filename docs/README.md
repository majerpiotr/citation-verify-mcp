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

## What used to be here

A `history/` folder held the original build plan and the round 2 and round 3 audit reports.
They were deleted: finished documents that no current file depended on, worth 1,415 lines of
material a reader had to identify and skip. `git log -- docs/history/` still has them.

A handful of comments in `src/` and `test/` cite a review as `(round-3 review, P0-2)`. That
is provenance, not a pointer - each one states its own reasoning in full and reads correctly
with no such document in the tree. Leave those citations alone; they record that an audit
found the case, which is worth knowing even once the report is gone.
