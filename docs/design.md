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

The server wears two hats: an MCP server to the host, and an MCP client to PageIndex's
hosted MCP endpoint. The host connects only to this server; it never sees how PageIndex is
reached.

```
Host agent
   |  stdio MCP: verify_citations(text)
   v
citation-verify server        <- this project
   |  HTTP MCP, Authorization: Bearer <key>  -> https://api.pageindex.ai/mcp
```

> Superseded by Spike B: the design assumed a primary path of spawning `npx -y
> pageindex-mcp` over stdio and calling its tools, with a direct-REST fallback to
> `api.pageindex.ai` if the spawn proved problematic. Neither exists. The published
> `pageindex-mcp` package (v1.6.3) is OAuth-only - it never reads `PAGEINDEX_API_KEY`, and
> spawning it triggers an interactive browser login incompatible with a pluggable,
> self-sufficient server (constraint C3). See `docs/spike-b-findings.md` section 1.

- **The connection is a single outbound HTTP MCP client.** This server connects directly
  to `https://api.pageindex.ai/mcp` using `StreamableHTTPClientTransport`, with the
  server's own API key sent as `Authorization: Bearer <key>`. There is no child process:
  no unpinned third-party package resolved at every spawn, and no environment-forwarding
  hazard to a subprocess - the hazard the old stdio-wrap path would have carried.
- The block is a Node/TypeScript MCP server built on `@modelcontextprotocol/sdk`. The
  wrapper is thin: MCP server surface + citation extraction + an HTTP MCP client to
  PageIndex + result mapping. It never reimplements PageIndex; the tool surface
  (`get_document`, `get_document_structure`, and others) comes from the backend for free.
- An invalid key fails at `connect`, as a thrown error - it maps to `unchecked` naturally.
  There is no path by which a bad key is mistaken for a missing document.

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
    {"token": str, "status": "resolved"|"unresolved"|"unchecked", "title": str|null,
     "suggestion": str|null}
  ]
}
```

`title` (from the resolved document metadata) lets the agent sanity-check it got the
right document, and seeds a future relevance layer.

> Superseded by Spike B: `details` entries originally carried only `{token, status,
> title}`. They now also carry `suggestion: string | null`, populated when it helps
> explain a non-`resolved` verdict: the backend's near-miss document name for an
> `unresolved` document, the real page count when a cited page falls outside it, or an
> explanation of which half of a combined page-plus-node citation failed. It is `null`
> when there is nothing useful to add (including for every `resolved` citation).

## 5. Citation grammar

> Superseded by Spike B: the design assumed `node_id` identifies a document, with default
> patterns `node_id[:=]\s*(<token>)` and `<doc_name>.pdf` with a page reference resolved
> independently. It does not: `node_id` values are small ordinals identifying a node
> inside ONE document's tree, and every document has a node `0000`. Sending a bare node id
> as a document name would report every such citation `unresolved` and delete valid
> citations wholesale - the exact failure CLAUDE.md hard rule 4 forbids. See
> `docs/spike-b-findings.md` section 6.

The corrected citation model: **a citation names a
DOCUMENT, optionally narrowed by a page or a node.** A document reference is verifiable on
its own; a page or node is verifiable only relative to its document; a bare node id with
no document in the same sentence is unverifiable by construction and must be reported
`unchecked`, never `unresolved`.

Implemented as a fixed grammar over the shapes below (extraction lives in this server's
deterministic code, not delegated to the citing agent). The exact shapes a given host's
agents actually emit still needs confirming against representative inputs (Spike A, not
yet run).

**What the grammar recognizes:**

- A document named as `<name>.pdf`, alone or with a page (`p.5`, `pp. 5-7`, `page 12`,
  `pages 5-7`) or with `node_id: <id>` (either order, within the same sentence). A
  document cited with both a page and a node id in the same sentence yields one combined
  citation (canonical token `<name>.pdf#p<N>&n<id>`), not two separate ones.
- A document name containing spaces must be wrapped in double quotes or backticks to be
  read exactly. Unquoted, it is read as its last space-free segment, so `Annual Report
  2024.pdf` is taken as `2024.pdf` - this never produces a false `resolved`, but a real
  citation to a space-bearing name goes unverified unless it is quoted.
- A quoted name is honoured verbatim only when it is file-name-shaped: at most 4 words and
  at most 80 characters. A name containing an apostrophe, `&`, a comma, a colon, or a
  non-ASCII character degrades to a truncated (unquoted) segment or is not extracted at
  all.
- Single quotes are not a delimiter - ordinary apostrophes in prose ("don't", "the team's")
  would otherwise be misread as opening a document name.
- A bare `node_id:` with no document in the same sentence is reported `unchecked`, never
  `unresolved`.
- The document name is matched case-sensitively, because the backend's lookup is
  case-sensitive; the page and node keywords (`p.`, `pp.`, `page`, `pages`, `node_id`) are
  not.
- Page ranges accept a hyphen, an en dash, or the word "to": `5-7`, `5 to 7`.

  > Corrected after the grammar was hardened: this section previously stated that a "to"
  > range was not recognized. It was in fact recognized as its FIRST PAGE ONLY, silently
  > dropping the rest, so `pages 5 to 7` was checked as page 5 and could return `resolved`
  > while page 7 was fabricated. The grammar now reads the whole range.

- A page marker must sit on the SAME LINE as the document name. It may follow the name
  directly, after an optional `,` or `;`, inside brackets (`report.pdf (page 5)`), or after
  one of the connectors `on`, `at`, `see`. Written any other way - on the next line, or
  separated from its name by another document mention - the page is not extracted and
  therefore not checked, while the document verdict still stands.

## 6. Connection and configuration

> Superseded by Spike B: the design implied the API key configured here would be
> forwarded to a spawned `pageindex-mcp` child process. There is no child process to
> forward it to. The same key now authenticates this server's own outbound HTTP MCP
> connection to PageIndex directly (section 3).

Registered by the host under `mcpServers` as a stdio-spawned process - this hop is
unchanged: the project is still distributed via `npx` (section 2's goals), and the host
still talks to it over stdio:

```json
{
  "mcpServers": {
    "citation-verify": {
      "command": "npx",
      "args": ["-y", "citation-verify-mcp"],
      "env": { "PAGEINDEX_API_KEY": "${PAGEINDEX_API_KEY}" }
    }
  }
}
```

- Plug = add this block. Unplug = remove it.
- The server reads `PAGEINDEX_API_KEY` from its own env block and uses it directly as the
  bearer token on its own HTTP MCP connection to `https://api.pageindex.ai/mcp` - not to
  spawn or configure anything else. It is independent of the host's other PageIndex setup
  (constraint C3).
- `PAGEINDEX_BASE_URL` overrides that endpoint, for a self-hosted PageIndex backend. It
  defaults to `https://api.pageindex.ai/mcp` and is not needed for PageIndex Cloud.
- `PAGEINDEX_FOLDER_ID` is NOT implemented. Nothing in the server today scopes a lookup to
  a folder; every `get_document` call resolves against the account's whole corpus. If
  folder scoping is needed later, it requires new work, not just configuration.

## 7. Host integration (consumer's responsibility)

Integration with a specific host is out of scope for this project. Generically, the
host instructs its agent: "Before finalizing, call `verify_citations` on your draft.
For each `unresolved` citation, remove the claim or search again and replace it with a
real citation. Leave `unchecked` citations in place with a note; do not delete them."

## 8. Correctness constraints

- **C1 - same corpus scope.** The server's API key must point at the same PageIndex
  account the agent cites from. Otherwise a valid citation resolves as `unresolved`
  (false negative), and a consuming agent deletes it.

  > Superseded by Spike B: this constraint originally also required matching a folder
  > scope via `PAGEINDEX_FOLDER_ID`. Lookups are not folder-scoped. `get_document` takes
  > a `doc_name` and the backend's optional `folder_id` argument is only a disambiguator
  > for two documents sharing a name, not a search scope. `PAGEINDEX_FOLDER_ID` is not
  > implemented and would not change which documents resolve. The account, not the
  > folder, is the unit that must match.

  The residual folder-related risk is narrower and worth stating: if two documents in the
  same account share a file name, `get_document` resolves one of them without saying
  which. Existence still answers correctly; identity does not. Disambiguating would mean
  passing `folder_id`, which the citation grammar has no way to carry today.
- **C2 - unresolved vs unchecked.** A backend failure must never be reported as
  `unresolved`. `unchecked` means "could not determine", so the agent does not delete
  good citations during an outage.
- **C3 - self-sufficiency.** The server does not depend on the host's own PageIndex
  process being configured or reachable. It uses its own key and connection. (A host's
  stdio MCP process is point-to-point and cannot be shared with a third party anyway.)

## 9. Spikes (do first)

- **Spike A - citation format.** NOT run. Confirm the citation token syntax the consuming
  agents actually emit, using representative inputs. If agents emit no resolvable tokens
  (only free-text references), the grammar plus host-side instruction must force a
  resolvable form. This is still risk #1 for the whole premise.
- **Spike B - confirm the real backend behaviour.** DONE, run against the live backend on
  2026-07-31 with a real API key.

  > Superseded by its own outcome: the spike was scoped to confirm that `npx pageindex-mcp`
  > could be spawned where the server runs, and that it would resolve a known-good
  > `doc_id` while reporting a fabricated one as not found - falling back to calling
  > `api.pageindex.ai` directly only if the spawn proved problematic. Instead it found the
  > spawn path does not work at all (the published package is OAuth-only), and that the
  > backend exposes something better than either option considered: an HTTP MCP endpoint
  > authenticated with the API key.

  Full findings in `docs/spike-b-findings.md`. They superseded the transport, the lookup
  argument, and the found/not-found discriminator this document assumed - see sections 3,
  5, and 6 above - and drove the rework that produced the current code.

## 10. Testing

- Test runner: TypeScript-native (`vitest`).
- Unit: citation extraction (grammar) over sample inputs.
- Unit: mapping of a PageIndex response -> `resolved | unresolved | unchecked`.

  > Superseded by Spike B: this mapping was assumed to work by inspecting a payload for
  > truthiness. It does not - a missing document arrives as `isError: true`, the same
  > channel as a genuine backend failure. The two are distinguished only by a positive
  > `errorCode: "NOT_FOUND"` in the body: that code means `unresolved`; an `isError`
  > without it, a thrown error, or an unparseable body all mean `unchecked`. See
  > `docs/spike-b-findings.md` section 4.

- Unit: existence is no longer checked at the document level alone - a cited page is
  bounds-checked against the document's real page count, and a cited node is checked
  against the document's structure tree, each with its own tests.
- Integration (key-gated): one known-good document name (resolved) + one fabricated name
  (unresolved) + a page beyond the real page count (unresolved) + a fabricated node id
  (unresolved) + a bare node id with no document (unchecked) + a client built with a bad
  key (unchecked, never `unresolved` - the invariant hard rule 4 protects).

## 11. Risks

- **R1 - no resolvable tokens emitted.** If consuming agents cite free text rather than
  a resolvable token, there is nothing to verify. Mitigation: Spike A, then host-side
  instruction pressure.
- **R2 - unquoted document names containing spaces go unverified.**

  > Supersedes R2 - REST/endpoint mismatch (fallback only): the risk that, if the wrap
  > path were unavailable and REST had to be used instead, its endpoints might differ from
  > what was assumed. There is no REST fallback to mismatch - Spike B confirmed the actual
  > transport (HTTP MCP) directly, so this risk no longer exists.

  The grammar cannot recover a bare (unquoted) document name that itself contains a space
  from surrounding prose - it reads only the name's last space-free segment. A citation to
  such a name therefore goes unverified (`unresolved` or `unchecked`, never a false
  `resolved`) unless the agent wraps the name in quotes. Mitigation: host-side instruction
  to quote document names containing spaces.
- **R3 - the API key's capability exceeds what this server uses.**

  > Supersedes R3 - Node/npx absent in the host runtime: the risk that Node/npx might be
  > unavailable wherever a spawned `pageindex-mcp` child needed to run. There is no such
  > child process for the PageIndex connection any more. Node/npx is still required for
  > the host-facing hop (this project's own distribution via `npx`, section 2), which
  > Spike B did not touch and did not need to test.

  The key authenticates a tool surface that includes `remove_document`, not only the
  read-only tools (`get_document`, `get_document_structure`) this server calls. A leaked
  or over-scoped key could delete documents from the corpus - an operational risk outside
  this server's own control. Mitigation: whoever provisions the key should scope it as
  narrowly as PageIndex allows; the server itself never calls a mutating tool.

## 12. Deferred roadmap (context, not scope)

Gateway observer (deterministic end-of-response pass, own store), audit log and trend
metrics, reuse detection and quote-overlap, grounding/NLI with calibrated confidence,
bounded self-correction, CI eval gate.
