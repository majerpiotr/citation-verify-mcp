# Rework plan - aligning the server with confirmed backend behaviour

> ## COMPLETED AND SUPERSEDED - HISTORICAL RECORD, NOT DOCUMENTATION
>
> This plan describes work that has since been carried out, and it is kept unchanged as a
> record of why the code changed. It was itself revised during execution, so its code
> blocks and task descriptions do not all match what shipped.
>
> **Do not implement from this document, and do not cite it as current behaviour.**
> Read instead: `spike-b-findings.md` (observed backend behaviour), `design.md` (the
> approved design), and `../README.md` (how the shipped server actually behaves).

> Supersedes `implementation-plan.md` Tasks 2-8 where they conflict. Driven by
> `spike-b-findings.md`, which replaced this project's three load-bearing assumptions:
> the transport, the lookup argument, and the found/not-found discriminator.

**What changed and why it forces a rework**

1. The stdio wrap is dead - the published package is OAuth-only. The backend exposes an
   HTTP MCP endpoint authenticated with the API key instead.
2. `get_document` takes `doc_name` (a case-sensitive file name), not a document id.
3. A missing document arrives as `isError: true` - the same channel as a failure -
   distinguished only by `errorCode: "NOT_FOUND"` in the body. The existing truthiness
   heuristic in `interpretDocResult` is therefore both unnecessary and wrong.
4. `node_id` identifies a node INSIDE one document's tree, not a document. The planned
   grammar would have sent node ids as document names and reported every one
   `unresolved` - deleting valid citations wholesale.

## Global constraints (unchanged unless stated)

- Node/TypeScript, ESM, `NodeNext`, `strict`. Runnable via `npx`.
- Standalone. No reference to any specific consuming host, anywhere.
- **Hard rule 4 stands and tightens:** `unresolved` requires a POSITIVE `NOT_FOUND` from
  the backend, or a positively-checked page/node miss. Everything ambiguous - a throw, an
  unparseable body, an `isError` without `NOT_FOUND`, a citation that cannot be checked at
  all - is `unchecked`.
- Still no persistence, no cache across calls, no retries, no self-correction loop.
- English for all artifacts. Explicit-path `git add`. `key.txt` is never read or staged.

## Target citation model (approved)

A citation names a DOCUMENT, optionally narrowed by a page or a node.

| Cited | Verifiable? | Verdict source |
|---|---|---|
| `<name>.pdf` | yes | `get_document` |
| `<name>.pdf` + page | yes | page within `page_count` |
| `<name>.pdf` + `node_id` | yes | node present in `get_document_structure` |
| bare `node_id:` with no document | **no** | always `unchecked` |

A bare node id is unverifiable by construction: every document has a node `0000`.

## Target interfaces

```ts
// src/pageindex-client.ts
export interface DocumentInfo { name: string; pageCount: number | null }
export type DocLookupResult =
  | { found: true; doc: DocumentInfo }
  | { found: false; similar: string[] };

export interface DocLookup {
  // Resolves to found/not-found. THROWS when the check could not run.
  getDocument(docName: string): Promise<DocLookupResult>;
  // Every node id in the document's tree, walked recursively across pages.
  // Only called when a node was actually cited. THROWS when the check could not run.
  getNodeIds(docName: string): Promise<Set<string>>;
}

// src/grammar.ts
export interface Citation {
  token: string;            // canonical, agent-facing
  docName: string | null;   // null => unverifiable without a document
  pages: { from: number; to: number } | null;
  nodeId: string | null;
}
export function extractCitations(text: string): Citation[];

// src/resolver.ts
export type CitationStatus = "resolved" | "unresolved" | "unchecked";
export interface CitationDetail {
  token: string;
  status: CitationStatus;
  title: string | null;
  suggestion: string | null;  // e.g. a near-miss document name, or the real page count
}
export interface VerifyResult {
  total: number; resolved: number;
  unresolved: string[]; unchecked: string[];
  details: CitationDetail[];
}
export async function verifyCitations(text: string, client: DocLookup): Promise<VerifyResult>;
```

`splitToken` is deleted - `extractCitations` now returns structured citations, which also
removes the duplicated page-number pattern that previously had to be kept in sync.

---

## Task R1: HTTP MCP client

**Files:** rewrite `src/pageindex-client.ts`; rewrite `test/pageindex-client.test.ts`.

- `PageindexHttpClient implements DocLookup`, connected via `StreamableHTTPClientTransport`
  to `https://api.pageindex.ai/mcp` with `Authorization: Bearer <key>`. Base URL overridable
  by `PAGEINDEX_BASE_URL` for a self-hosted backend (design.md section 6).
- `static async connect(apiKey: string): Promise<PageindexHttpClient>`.
- Export a PURE `interpretGetDocument(res: unknown): DocLookupResult` that throws on
  anything ambiguous - this is the unit-testable heart and replaces `unwrap` +
  `interpretDocResult`, both of which are deleted.
  - `success: true` -> `{found:true, doc:{name, pageCount}}`
  - `isError` + body parses + `errorCode === "NOT_FOUND"` -> `{found:false, similar}`
  - anything else -> throw, with a truncated (<=200 char) excerpt for diagnosis
- Export a PURE `collectNodeIds(structure: unknown): Set<string>` that walks the tree
  recursively through `nodes` arrays and throws on a shape it cannot read.
- `getNodeIds` must follow `pagination.has_more` via the `part` argument, with a hard cap
  on parts so a misbehaving backend cannot loop forever; exceeding the cap throws.

**Tests** (offline, no key, no network - the transport is not unit-tested):
`interpretGetDocument` over: a success body; a `NOT_FOUND` body with and without
`similar_files`; an `isError` body with a different `errorCode`; an `isError` body that is
not JSON; a success body missing `page_count`; an empty/garbage envelope. `collectNodeIds`
over: a flat tree; a nested tree; an empty structure; a malformed node.

## Task R2: grammar for the real citation model

**Files:** rewrite `src/grammar.ts`; rewrite `test/grammar.test.ts`.

Recognized shapes, all case-insensitive on the page/node keywords and preserving the
document name's case verbatim (the backend is case-sensitive, so we must not normalize it):

- `<name>.pdf` - document only. Canonical token: `<name>.pdf`
- `<name>.pdf` + `p.<N>` / `p. <N>` / `pp.<N>-<M>` / `page <N>` / `pages <N>-<M>`,
  optionally separated by `,` or `;`. Canonical token: `<name>.pdf#p<N>` or
  `<name>.pdf#p<N>-<M>`
- `<name>.pdf` + `node_id: <id>` / `node_id=<id>` (either order, within the same sentence).
  Canonical token: `<name>.pdf#n<id>`
- bare `node_id: <id>` with no document in the same sentence -> `docName: null`,
  canonical token: `node_id:<id>`

Rules that must hold:
- unique by canonical token, in first-seen order across ALL patterns
- trailing sentence punctuation is never captured
- a document name may contain dots (`annual.report.pdf`)
- an empty or whitespace-only document name is never emitted

## Task R3: resolver

**Files:** rewrite `src/resolver.ts`; extend `test/resolver.test.ts`.

Per citation, in order:
1. `docName === null` -> `unchecked`, suggestion explaining a node needs its document.
2. `getDocument(docName)` - throws -> `unchecked`. `found:false` -> `unresolved`,
   suggestion = first `similar_files` entry when present.
3. `pages` cited and `pageCount` known and the range falls outside `1..pageCount` ->
   `unresolved`, suggestion naming the real page count. `pageCount` unknown -> the page is
   NOT checked; the document verdict stands and the suggestion says so.
4. `nodeId` cited -> `getNodeIds(docName)`; throws -> `unchecked`; absent -> `unresolved`.
5. otherwise `resolved`, title = the document's real `name`.

Constraints: one detail per citation in first-seen order; `total === details.length`;
each distinct `docName` looked up at most once per call, and node ids fetched at most once
per document per call (per-call only - never a cache across calls).

## Task R4: MCP server surface

**Files:** `src/server.ts`, `test/server.test.ts`.

Rewrite the tool description for the real model: recognized shapes; that a bare `node_id`
cannot be verified and is reported `unchecked`; that pages and nodes ARE verified now;
what `suggestion` carries; the existing field shapes and the "never delete `unchecked`"
imperative. Tests must pin every load-bearing clause and the `suggestion` field.

## Task R5: binary entry point

**Files:** `src/index.ts`.

Connect `PageindexHttpClient` instead of spawning a child. Keep the key guard, the shebang,
`process.exitCode` + `return` in the guard, and `process.exit(1)` in the top-level catch.

## Task R6: integration test against the real backend

**Files:** `test/integration.test.ts`.

Credential-gated on `PAGEINDEX_API_KEY` plus `CITATION_VERIFY_TEST_DOC_NAME` (the name of
a document that really exists). Skipped entirely when either is absent. Asserts:
a real document resolves; a fabricated name is `unresolved`; a page beyond the real page
count is `unresolved`; a fabricated node id is `unresolved`; a bare `node_id` is
`unchecked`; and - the invariant - that a client built with a bad key produces `unchecked`
and never `unresolved`.

No document-specific or domain-specific name may be hardcoded; everything comes from env.

## Task R7: README and design alignment

**Files:** `README.md`, `docs/design.md`.

README: what it is, the `mcpServers` block with `PAGEINDEX_API_KEY`, the tool contract,
the recognized citation shapes, and the host-side instruction. `design.md`: sections 3, 5,
6 and 10 updated to the confirmed transport, grammar and discriminator, with the superseded
assumptions marked as such rather than silently rewritten.
