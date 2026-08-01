# Spike B findings - confirmed backend behaviour

> Status: complete. Run against the live backend on 2026-07-31 with a real API key.
> These findings supersede the assumptions in `design.md` sections 3 and 5, and the
> code shapes in `implementation-plan.md` Tasks 3-6.

Every statement below was observed, not inferred. Throwaway probe scripts lived in a
gitignored scratch directory and were not committed.

## 1. Transport: HTTP MCP, not a spawned stdio process

The design assumed the primary path was spawning `npx -y pageindex-mcp` over stdio with
`PAGEINDEX_API_KEY` in the child's environment. **That does not work.** The published
`pageindex-mcp` package (v1.6.3) authenticates with browser-based OAuth and never reads
`PAGEINDEX_API_KEY` - the only environment variable referenced anywhere in its build is
`PAGEINDEX_API_URL`. Spawning it yields:

```
No existing OAuth tokens found, starting fresh authentication.
Failed to initialize remote connection: Protected resource https://app.pageindex.ai
does not match expected https://chat.pageindex.ai/mcp?local_upload=1 (or origin)
```

An interactive browser login per host is incompatible with a pluggable, self-sufficient
server (design constraint C3).

**The backend instead exposes an HTTP MCP endpoint authenticated with the API key:**

```
url:     https://api.pageindex.ai/mcp
headers: Authorization: Bearer <PAGEINDEX_API_KEY>
```

This is strictly better than both the stdio wrap and the REST fallback:

- No child process, so no unpinned third-party package resolved at every spawn, and no
  environment forwarding to it.
- Authenticated with the server's own key, satisfying C3 directly.
- The full tool surface is available for later layers.

## 2. Authentication failure is a transport-level throw

Connecting with an invalid key fails at `connect`:

```
Streamable HTTP error: Error POSTing to endpoint: {"detail":"Could not validate credentials"}
```

It throws rather than returning a value, so it maps to `unchecked` naturally. There is no
path by which a bad key can be mistaken for a missing document.

## 3. Tool surface

```
browse_documents  search_documents  get_document  get_document_structure
get_page_content  get_document_image  remove_document
```

**Operational note:** `remove_document` is reachable on this connection. This server calls
only read tools, but the key it is given carries the capability to delete documents.
Whoever provisions the key should be aware of that.

## 4. `get_document` - the existence check

**Argument:** `doc_name`, a string. `doc_id` is NOT accepted:

```
args: { doc_id: "pi-cms9..." }
-> isError: true, "Invalid arguments for tool get_document: doc_name ... expected string, received undefined"
```

`doc_name` is the document's **file name including its extension**, and it is
**case-sensitive**. Optional `folder_id` disambiguates same-named documents.

**Found:**

```json
{ "success": true, "name": "<name>.pdf", "description": "...", "status": "completed",
  "created_at": "...", "page_count": 56, "folder_id": null, "next_steps": { ... } }
```

**Not found** - returned as `isError: true` with a structured body:

```json
{ "error": "Document not found. Did you mean: \"<name>.pdf\"?",
  "errorCode": "NOT_FOUND", "doc_name": "<what was asked for>",
  "similar_files": ["<name>.pdf"], "next_steps": { ... } }
```

Observed variants: an exact-name miss returns `similar_files: []`; a near miss (extension
omitted) returns the close match; a case variant (`NAME.PDF` for `name.pdf`) is NOT found
and returns `similar_files: []`.

### The discriminator

This is the single most important finding, and it inverts a previous assumption.

**A missing document arrives as `isError: true`, the same channel as a backend failure.**
Treating every `isError` as "could not check" would make every genuine absence
`unchecked`, so no fabricated citation would ever be caught - the tool would verify
nothing. The two cases are distinguished by the body:

| Outcome | Signal | Verdict |
|---|---|---|
| Document exists | `success: true` | `resolved` |
| Document absent | `isError: true` AND `errorCode: "NOT_FOUND"` | `unresolved` |
| Anything else | `isError: true` without that code, a thrown error, an unparseable body | `unchecked` |

`unresolved` requires a POSITIVE `NOT_FOUND` code. Ambiguity is `unchecked` (hard rule 4).

## 5. Page numbers and node ids are verifiable

`get_document` returns `page_count`, so a cited page can be bounds-checked against the
real document rather than accepted on trust.

`get_document_structure(doc_name)` returns the document's tree:

```json
{ "success": true, "doc_name": "<name>.pdf",
  "structure": [
    { "title": "...", "node_id": "0000", "start_index": 1, "end_index": 1, "summary": "..." },
    { "title": "...", "node_id": "0002", "start_index": 6, "end_index": 6,
      "nodes": [ { "title": "...", "node_id": "0003", "start_index": 6, "end_index": 6 } ] }
  ],
  "pagination": { "has_more": false } }
```

Nodes nest under a `nodes` array, so the tree must be walked recursively. Responses are
paginated by a `part` argument; `pagination.has_more` signals more parts.

## 6. `node_id` is scoped to a document - this invalidates the planned grammar

`node_id` values are small ordinals (`"0000"`, `"0001"`, `"0002"`) identifying a node
**inside one document's tree**. They are not document identifiers, and they are not
unique across the corpus - every document has a node `"0000"`.

The document namespace is separate: `pi-cms9fe2s70bd701pgbsh9v14b`. Those ids appear in
the REST listing but are NOT accepted by `get_document`, which wants the file name.

**Consequence for `design.md` section 5.** Its default pattern `node_id[:=]\s*(<token>)`
extracts a node id and the resolver was written to send it as a document identifier. Every
such token would come back not-found and be reported `unresolved`, so a consuming agent
would delete valid citations wholesale - the exact failure hard rule 4 forbids, at 100%
rate for that token shape.

**Resulting citation model** (approved): a citation names a DOCUMENT, optionally narrowed
by a page or a node.

- A document reference is verifiable on its own.
- A page or node is verifiable only relative to its document.
- A bare `node_id:` with no document is **unverifiable by construction** and must be
  reported `unchecked`, never `unresolved`.

## 7. Open items this spike does NOT settle

- **Spike A** still owns the question of which token shapes consuming agents actually
  emit. This spike settles what the backend accepts, not what agents write.
- Folder scoping (`folder_id`) is available on both tools but untested here; the corpus
  used had a single root-level document.
- Pagination of `get_document_structure` was not exercised - the test document returned
  `has_more: false` in one part.
