# Integration guide: getting a real resolve rate

Registering this server is the easy part, and it is not what decides whether verification
actually happens. This guide is the list of things that do.

Read it before wiring the tool into an agent system. Every item below is something that made the
difference between "verification is configured" and "verification is working", and several of
them fail *silently* - the pipeline looks correct, the output looks verified, and nothing was
ever checked.

**Where this comes from.** `docs/spike-a-findings.md` recorded what one multi-agent application
emitted before anyone tried to fix it: in a 40,506-character transcript full of confident
argument, the checker found **zero** citations of any recognisable shape. This document is the
other half of that story - the same application, a delegating system in which roughly
twenty-five specialist roles debate a proposal and cite a corpus of reference documents, was
then actually wired up and run. The items are in the order they bit.

Every claim here was measured against a running system. Nothing is inferred from documentation.
The application is deliberately anonymised, per this project's host-agnostic rule; none of the
lessons depend on what its documents were about.

## The short version

1. Put the tool in the context of the agent that *cites*, not the one that orchestrates.
2. Use a model that actually calls tools, and never trust a self-reported check.
3. Count tool invocations. Zero invocations means unverified, whatever the agent wrote.
4. Make the verification result part of the required output format.
5. Show the agents the real document names. They cannot copy what they have never seen.
6. Wire up retrieval first. Verification without it just measures guessing.
7. Make every relaying agent carry file names and page numbers across verbatim.

---

## 1. The tool has to reach the agent that cites

The orchestrator held the MCP connection; the specialist roles that actually write
citations were spawned as delegated children. In that framework, children inherit the parent's
MCP tools only when the delegation config says so - the default was off, so the agents doing the
citing had no verification tool at all, while the agent that had it never cited anything.

Symptom: everything looks configured, `mcp test` connects, and not one verification happens.

**Check that the tool is present in the context of the agent that emits citations, not the one
that orchestrates them.** In a delegating framework this is a separate setting from registering
the server.

## 2. A model that cannot call tools will write the answer anyway

This was the most dangerous finding, and it produces evidence of verification where none
happened.

Instructed to call `verify_citations` and report the result, a cheap model produced:

```
**5. Citation check**
Checked: 3 citations, 3 resolved.
```

The session record showed the tool declared and **invoked zero times**. The numbers were
invented. They happened to be correct, because retrieval had already handed the model real file
names - so the fabrication was indistinguishable from a real check by reading the output alone.

Measured across three models on the same task:

| Model class | Retrieval calls | `verify_citations` calls | Reported section |
| --- | --- | --- | --- |
| cheap "flash/lite" tier | 3-7 | **0** | fabricated |
| mid tier (two different vendors) | 3-5 | 3-5 | matched an independent re-check exactly |

Retrieval gets called reliably because the model needs it to write anything. Verification is
skippable: the answer can be produced without it. That asymmetry is the whole problem.

**Pick a model that actually calls tools, and do not trust a self-reported check.**

## 3. Count the invocations, do not read the claim

Following from the above: the only trustworthy signal that verification happened is a record of
the call. If your framework keeps session transcripts, count invocations of the tool and treat a
count of zero as "unverified", regardless of what the agent wrote.

This costs almost nothing and is the difference between "3 citations verified" and "an agent
wrote that 3 citations were verified".

## 4. Make the result part of the output contract

Instructions that sit *after* the output format get skipped - the model produces its required
sections and stops. Moving verification into the required output helped:

```
**5. Citation check**
Call verify_citations with sections 1-4 as `text`, then report:
Checked: <total> citations, <resolved> resolved.
```

A section whose content cannot be written without the tool's output is harder to skip than a
closing instruction. It is not sufficient on its own (see §2 - a weak model fabricates the
section instead), but combined with a capable model it worked in every run.

## 5. Agents cannot copy a name they have never seen

The corpus held six documents. The prompts told agents to cite "the exact file name" without
ever showing them what those names were, so they invented plausible ones and every citation
came back `unresolved` with `title: null`.

Injecting the actual list - file name, human title, page count - into the prompt changed the
resolve rate more than any other single edit.

Generate that list from something that cannot drift from the live corpus. The application's own
manifest of what it *tried* to ingest was wrong: three of its five entries named documents that
did not exist, and it omitted four that did.

## 6. Verification without retrieval measures guessing

Before the agents could read the corpus, they cited from memory and the checker faithfully
reported how wrong they were. That is a working checker and a useless pipeline.

Once retrieval was wired in, the specialist roles opened documents, read pages, and cited what
they had read - and the same checker started returning `3/3 resolved` on transcripts that had
previously returned `0`.

**This server tells you whether a citation resolves. It cannot make an agent look anything up.**
If your resolve rate is near zero, the fix is usually upstream of verification.

## 7. A summarising orchestrator destroys citations

The specialist roles cited correctly. The orchestrator then summarised their findings in prose
and rewrote `real-doc.pdf p.5` as "in accordance with the second section of that source". The
final transcript - the only artefact a reader sees - contained **zero** verifiable citations,
while every input to it had been verifiable.

If any agent relays another agent's claims, instruct it to carry file names and page numbers
across **verbatim**. A citation survives only as long as every hop preserves it.

## 8. `total: 0` is not a pass

Worth repeating because it is easy to misread on a dashboard: zero found citations means nothing
checkable was written. On a transcript full of legal argument that is a failure, not a clean
bill of health.

## 9. `unchecked` must never delete anything

Enforced in the prompts from the start, and worth stating loudly to your agents: a citation the
backend could not check is not a citation known to be bad. During an outage every citation
becomes `unchecked`; an agent that treats that as "unverified, therefore remove" strips a
document of its entire grounding because a service was briefly down.

## 10. Non-English prose needs an explicit format rule

The grammar recognises `p.`, `pp.`, `page`, `pages` and the separators `and`/`or`. Agents
writing in another language naturally reach for their own page word and their own conjunction -
in the run measured here, `strona 12` and `oraz`/`i`/`lub` - and both silently drop the page
while still reporting `resolved` on the document.

The workaround costs nothing and worked: instruct agents to write `p.12` / `pp. 5-7` in Latin
script inside otherwise non-English prose, and to separate citations with a comma, a semicolon
or a full stop. See the grammar reference for the full disclosed behaviour.

---

## What did not need changing

The server itself. Across the whole integration it returned no incorrect verdict: every
`resolved`, `unresolved` and `unchecked` matched an independent re-check, both documented
page-keyword traps reproduced exactly as described, it refused to start without a key, and it
returned `unchecked` rather than guessing on unbound node ids - which is precisely what stopped
agents from deleting citations it could not evaluate.

Every problem found during the integration was in the consuming application: tool routing, model
choice, prompt structure, and an orchestrator that discarded what its own experts produced.
