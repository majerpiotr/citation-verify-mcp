# citation-verify-mcp - Design

> Status: design approved. Standalone project.

## 1. Problem

LLM and RAG agents emit citations that look authoritative but do not resolve against
any real source. The dangerous failure mode is not merely wrong text - it is a
fabricated source that passes a human's eyeball test. Anyone can generate citations;
almost nobody verifies them at serve time.

The fix must remove the model from the trust path for the checkable part. Existence -
"does this cited document actually exist in the knowledge base" - is a deterministic
fact, resolved by code calling the source of truth. It must never be delegated to a
second model that can hallucinate just like the first.

## 2. Goals and non-goals (v0)

### Goals
- A standalone, pluggable MCP server exposing one tool, `verify_citations`.
- Called in-loop by a consuming agent to check its own citations before finalizing.
- Deterministic existence check against PageIndex.
- Stateless (no database).
- Distributed as a Node/TypeScript MCP server, runnable via `npx`, so it plugs into any
  MCP host regardless of that host's language.
- Couples to the citation format, not to any specific host.

### Non-goals (explicitly deferred)
- Gateway / end-of-response deterministic pass.
- Any persistence: database, audit log, cache.
- Relevance signals: reuse detection, quote-overlap, claim-document similarity.
- Grounding / entailment (NLI) and calibrated confidence.
- Bounded self-correction loops or orchestrator re-delegation.
- Host-side rendering (badges, UI). That belongs to the consumer.

## 3. Architecture

The server wears two hats: an MCP server to the host, and an MCP client to
`pageindex-mcp`. The host connects only to this server; it never sees how PageIndex is
reached.

```
Host agent
   |  stdio MCP: verify_citations(text)
   v
citation-verify server        <- this project
   |  stdio MCP (primary)      -> pageindex-mcp (local npx) -> PageIndex Cloud
   |  OR HTTPS (fallback)      -> PageIndex Cloud (api.pageindex.ai)
```

- **Primary: wrap `pageindex-mcp`.** Spawn `npx -y pageindex-mcp` and call its tools.
  This gives the full PageIndex capability surface immediately and proven:
  `get_document` (v0 existence), plus `get_page_content`, `get_document_structure`,
  `search_documents` that later layers (quote-overlap, grounding) will need. Response
  unwrapping is already handled by pageindex-mcp. Cost: one extra local process.
- **Fallback: call PageIndex directly.** Hit `api.pageindex.ai` (or an in-process JS
  client if one exists) with no second subprocess, but each operation must be
  reimplemented and the endpoints are unverified. Considered only if spawning `npx`
  proves problematic.

The block is a Node/TypeScript MCP server built on `@modelcontextprotocol/sdk`. The
wrapper is thin: MCP server surface + citation extraction + a small MCP client to
pageindex-mcp + result mapping. It never reimplements PageIndex; the toolset comes from
pageindex-mcp for free.

## 4. Tool interface

The consuming agent passes its **draft text**, not a list of tokens. Extraction lives
in this server's deterministic code so the agent cannot under- or mis-report its own
citations.

```
verify_citations(text: string) -> {
  "total": int,
  "resolved": int,
  "unresolved": [str],   # checked against the corpus, not found
  "unchecked": [str],    # could NOT be checked (no key, timeout, backend down)
  "details": [
    {"token": str, "status": "resolved"|"unresolved"|"unchecked", "title": str|null}
  ]
}
```

`title` (from the resolved document metadata) lets the agent sanity-check it got the
right document, and seeds a future relevance layer.

## 5. Citation grammar

Default built-in patterns:
- `node_id[:=]\s*(<token>)`
- `<doc_name>.pdf` with a page reference -> `<doc_name>.pdf#p<N>`

Implemented as a swappable grammar so other citation styles can be added later without
touching the resolver. The exact patterns a given host emits must be confirmed against
representative inputs (Spike A).

## 6. Connection and configuration

Registered by the host under `mcp_servers`:

```yaml
mcp_servers:
  citation-verify:
    command: npx
    args: ["-y", "citation-verify-mcp"]
    env:
      PAGEINDEX_API_KEY: "${PAGEINDEX_API_KEY}"
      # PAGEINDEX_FOLDER_ID optional; defaults to "root". Must match the folder
      # the citing agent uses (see Constraint C1).
```

- Plug = add this block. Unplug = remove it.
- The server reads its own key from its own env block, independent of the host's other
  PageIndex setup.
- No address is passed for PageIndex Cloud (the endpoint is known). A
  `PAGEINDEX_BASE_URL` env would be added only for a self-hosted PageIndex.

## 7. Host integration (consumer's responsibility)

Integration with a specific host is out of scope for this project. Generically, the
host instructs its agent: "Before finalizing, call `verify_citations` on your draft.
For each `unresolved` citation, remove the claim or search again and replace it with a
real citation. Leave `unchecked` citations in place with a note; do not delete them."

## 8. Correctness constraints

- **C1 - same corpus scope.** The server's API key and folder scope must point at the
  same PageIndex account/folder the agent cites from. Otherwise a valid citation
  resolves as `unresolved` (false negative). Folder scope defaults to `root`; if the
  agent cites from a specific folder, set `PAGEINDEX_FOLDER_ID` to match.
- **C2 - unresolved vs unchecked.** A backend failure must never be reported as
  `unresolved`. `unchecked` means "could not determine", so the agent does not delete
  good citations during an outage.
- **C3 - self-sufficiency.** The server does not depend on the host's own PageIndex
  process being configured or reachable. It uses its own key and connection. (A host's
  stdio MCP process is point-to-point and cannot be shared with a third party anyway.)

## 9. Spikes (do first)

- **Spike A - citation format.** Confirm the citation token syntax the consuming agents
  actually emit, using representative inputs. If agents emit no resolvable tokens (only
  free-text references), the grammar plus host-side instruction must force a resolvable
  form. This is risk #1 for the whole premise.
- **Spike B - wrap works in the target runtime.** Confirm `npx pageindex-mcp` can be
  spawned where the server runs, and that it resolves one known-good `doc_id` and
  reports a fabricated id as not found. Only if the `npx` spawn is problematic, spike
  calling `api.pageindex.ai` directly (the fallback).

## 10. Testing

- Test runner: TypeScript-native (`vitest`).
- Unit: citation extraction (grammar) over sample inputs.
- Unit: mapping of PageIndex response -> `resolved | unresolved | unchecked`.
- Integration (key-gated): one known-good `doc_id` (resolved) + one fabricated id
  (unresolved) + a forced backend failure (unchecked).

## 11. Risks

- **R1 - no resolvable tokens emitted.** If consuming agents cite free text rather than
  a resolvable token, there is nothing to verify. Mitigation: Spike A, then host-side
  instruction pressure.
- **R2 - REST/endpoint mismatch (fallback only).** If the wrap path is unavailable and
  REST must be used, resolve endpoints may differ. Mitigation: prefer the wrap path.
- **R3 - Node/npx absent in the host runtime.** The server is Node and wrap spawns
  `npx`, so Node is required wherever the server runs. Confirmed by Spike B.

## 12. Deferred roadmap (context, not scope)

Gateway observer (deterministic end-of-response pass, own store), audit log and trend
metrics, reuse detection and quote-overlap, grounding/NLI with calibrated confidence,
bounded self-correction, CI eval gate.
