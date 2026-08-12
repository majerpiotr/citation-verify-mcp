# Spike B findings - confirmed backend behaviour

> Status: complete. Run against the live backend on 2026-07-31 with a real API key.
> These findings supersede the assumptions in `design.md` sections 3 and 5, and the
> code shapes in `history/implementation-plan.md` Tasks 3-6.

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
args: { doc_id: "pi-xxxx..." }
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

Observed variants: a name matching nothing at all returns `similar_files: []`; a near miss
with the extension omitted (`name` for `name.pdf`) returns the close match. Case variants
split, and the split decides whether an operator gets a hint or silence:

- **Only the extension's case differs** (`name.PDF` for `name.pdf`): NOT found, but
  `similar_files` DOES carry the correct name.
- **The case of the name's stem differs** (`Name.pdf` or `NAME.PDF` for `name.pdf`): NOT
  found, and `similar_files` is `[]` - the backend goes completely silent, offering no hint
  that the document exists under a different capitalisation.

Same-case typos split the same way, and WHERE the typo falls decides it. Against a real
`konstytucja.pdf`, a hint came back for `konstytucia.pdf` (one letter substituted near the
end), `konstytucj.pdf` (final letter dropped), `konstytucjaa.pdf` (one letter too many) and
`konstytucja-rp.pdf` (suffix added); a hint also came back for `zwiazki-zawodowe.pdf`, a
bare fragment of a longer real name. But `knostytucja.pdf` (the second and third letters
transposed) and `kostytucja.pdf` (a letter dropped from the middle) both returned
`similar_files: []`. The matcher appears to reward a shared prefix or containment, so a
typo near the START of a name lands in the same silence as a case mismatch - and a
transposition is the commonest keyboard typo there is. Mechanism inferred from eleven
probes, not confirmed.

None of this changes the verdict: every case above is `unresolved`. That is the point. The
tool does not try to tell a typo from a fabrication, because the remedy is the same either
way - go and read the corpus's real file name.

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
  "next_steps": { ... } }
```

Nodes nest under a `nodes` array, so the tree must be walked recursively.

### Pagination - observed, and narrower than the schema suggests

The tool's schema documents a `part` argument and a `pagination.has_more` flag, but on a
real 56-page document (32 nodes, single part) the behaviour is:

- **`pagination` is ABSENT from the response entirely** - not `{"has_more": false}`, the
  key simply does not exist. Code must therefore treat a missing `pagination` as "this was
  the last part". Treating it as an error would make node verification fail on every
  normal document.
- **`part` is 1-based.** `part: 0` is rejected with a validation error
  (`too_small, minimum: 1`).
- **An out-of-range `part` returns the full structure again**, not an empty one:
  `part: 2` and `part: 99` both returned the same 32 nodes as `part: 1`. So over-paging
  duplicates rather than truncating, which a `Set` absorbs harmlessly.

A multi-part outline was never produced, so the `has_more: true` continuation path remains
unobserved. Code that walks it must still refuse to return a partial set: a truncated walk
makes a real node look absent, which becomes a false `unresolved`.

## 6. `node_id` is scoped to a document - this invalidates the planned grammar

`node_id` values are small ordinals (`"0000"`, `"0001"`, `"0002"`) identifying a node
**inside one document's tree**. They are not document identifiers, and they are not
unique across the corpus - every document has a node `"0000"`.

The document namespace is separate: `pi-` followed by 25 lowercase alphanumeric characters,
e.g. `pi-xxxxxxxxxxxxxxxxxxxxxxxxx` (a placeholder of the observed shape; the real ids seen
during this spike are account-specific and are not reproduced here). Those ids appear in the
REST listing but are NOT accepted by `get_document`, which wants the file name.

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

## 7. Free-tier account limits, observed while populating a corpus

The figures in this section describe a **free account specifically**, not the service as a
whole; paid plans differ, and no paid plan was observed here. Do not read a tier's quota as
a property of the product.

These bind ingestion, not the read path this server uses. They are recorded here because
they bind design constraint C1: the corpus must actually contain the documents an agent
cites, or every citation resolves to `unresolved` for a reason that has nothing to do
with fabrication.

- A free account carries a **total quota of 200 pages across all stored documents**. It
  is NOT a per-document page cap. Exceeding it fails the upload with
  `403 {"detail":"LimitReached"}`.
- The quota is checked against the whole submitted document, so a document that would
  push the account past 200 pages is rejected outright rather than partially ingested.
  Every rejection observed satisfied `pages_already_used + pages_in_document > 200`, and
  none was explained by the document's own size: a 66-page document was accepted at 67
  pages used, and a 29-page document was rejected at 200 pages used.
- `POST /doc` rejects a `metadata` object carrying a null value:
  `400 {"detail":"metadata value for '<key>' must be str, int, float, or bool"}`.
- Ingestion is asynchronous. `POST /doc` returns `{"doc_id": ...}` at once and the
  document reports `status: "processing"` until indexing finishes; `get_document` is
  only meaningful once it reads `completed`.
- The lookup key is the file name sent in the multipart `filename` field (section 4), so
  the ingesting side decides, at upload time, what string a citation must reproduce
  exactly. A corpus whose file names no agent can guess is unverifiable by construction.

## 8. Open items this spike does NOT settle

- **Spike A** still owns the question of which token shapes consuming agents actually
  emit. This spike settles what the backend accepts, not what agents write.
- Folder scoping (`folder_id`) is available on both tools but untested here; the corpus
  used had a single root-level document.
- Pagination of `get_document_structure` was not exercised - the test document returned
  `has_more: false` in one part.
