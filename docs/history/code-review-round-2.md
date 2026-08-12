# Code review: round 2

> **HISTORICAL RECORD - do not implement from this document.** Its findings were fixed on
> this branch before round 3 ran. It is kept for the reasoning behind decisions that are now
> load-bearing in the code, not as a description of anything outstanding. For current
> behaviour read `CLAUDE.md`, `README.md` and `docs/citation-grammar.md`.

**Scope:** `origin/feature/citation-verify-core..0abc1eab049fdc4d438d99b5ed779554626ec5b6`.

## Verification performed

- `npm test`: 438 passed, 8 skipped.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm pack --dry-run`: passed.
- `git diff --check origin/feature/citation-verify-core..HEAD`: passed.

## Findings

### P1 — cancellation can still return a successful result

`verifyCitations` checks `signal.throwIfAborted()` only before each citation
([`src/resolver.ts`](../../src/resolver.ts#L236-L245)). If cancellation happens while
the final (or only) citation is being classified, there is no subsequent loop boundary.
The function completes and returns a normal result despite the request having been
cancelled.

Reproduction against the built code: a fake `getDocument` aborts the supplied controller
and then returns a valid document for the only citation. The call returns
`{ "calls": 1, "status": "resolved" }`, not a rejected promise.

This contradicts the new handler's intended contract that a cancelled request has no
result and should stop work. Existing cancellation tests cover abort-before-start and
abort-before-the-next citation, but not abort during the final one.

**Required change:** check the signal after `await classify(...)` as well as before it,
and add the single-citation regression test. The normal result must not be emitted after
the request was cancelled.

### P1 — cancellation does not reach a paginated node-structure lookup

The signal is forwarded only as far as `verifyCitations`
([`src/server.ts`](../../src/server.ts#L161-L163)), but it is not passed to `DocLookup`,
`PageindexHttpClient`, or `accumulateNodeIds`
([`src/pageindex-client.ts`](../../src/pageindex-client.ts#L460-L469)). A cited node can
make `accumulateNodeIds` issue up to 50 sequential `get_document_structure` calls. If
the request is cancelled after part 1 reports `has_more: true`, the current code has no
check before part 2 and continues through all later parts.

The distinct-document cap does not mitigate this: 50 cited documents with paginated
outlines can still make up to 2,550 backend calls (50 document lookups plus 50 × 50
structure parts), each with the SDK's 60-second request timeout.

**Required change:** propagate the signal through the lookup interface and check it
before every structure-page request. If supported by the SDK, pass it to `callTool` too,
so an in-flight HTTP request is aborted rather than merely preventing the next page.
Add a test that aborts after page 1 and proves that page 2 is never requested. Preserve
the current safety invariant: cancellation must escape as cancellation, not be converted
to `unchecked` by a lookup catch block.

### P2 — the name-echo fix weakens the documented exact-name contract for Unicode

`assertNameEcho` accepts two different strings whenever their NFC-normalized forms match
([`src/pageindex-client.ts`](../../src/pageindex-client.ts#L177-L190)). Therefore a request
for `café.pdf` and a response naming `café.pdf` are treated as the same document. This
is not a case-only serialization detail: the two raw filenames are distinct on filesystems
and storage systems that preserve Unicode normalization, and the public documentation
promises the *exact stored file name*.

This may be an intentional PageIndex identity rule, but the repository provides no
observed backend evidence for it. If the backend normalizes names, the public contract
must say that matching is NFC-normalized and explain duplicate-normal-form behavior. If
it does not, the safe implementation is raw equality and a normal-form mismatch must
become `unchecked`.

**Developer decision required:** document the PageIndex normalization contract with an
integration probe, or change the guard to exact code-unit equality. Do not leave a
different identity rule implicit in a defense-in-depth check.

## Previous findings: disposition

| Previous finding | Status | Assessment |
| --- | --- | --- |
| Response name was not tied to requested name | Fixed | A differing echo now becomes `unchecked`; see the Unicode policy issue above. |
| Non-boolean `isError` was treated as false | Fixed | [`getResultEnvelope`](../../src/pageindex-client.ts#L86-L92) rejects every non-boolean value, and tests cover the unsafe success shape. |
| `_internal draft.pdf` and over-80-character quoted names leaked a tail fragment | Partly fixed | Leading `_`, `-`, and `.` names are accepted; name-shaped quoted spans over 80 characters and within four words are reserved. |
| Quoted names over four words leak a tail fragment | Deliberately accepted | The project documents this as indistinguishable from prose. It remains a real false-target risk: `"Q3 Financial Results Final Draft.pdf"` is checked as `Draft.pdf`. |
| Unbounded number of distinct lookups | Partly fixed | The 50-document cap prevents the original days-long document sweep, but it does not cap structure-page requests; see P1 above. |
| Tool description is about 9,200 characters (~2,300 tokens) | Unchanged / accepted | It is still an avoidable tool-discovery context cost and is coupled to a large regex-based documentation test. No functional defect was found in this round. |

## Residual accepted risk

There is intentionally no input-size cap. This remains a memory-availability decision:
the grammar allocates multiple `Uint8Array`s proportional to input size before the lookup
cap can help. The documented parser measurements support normal drafts, not arbitrary
MCP callers. If this server will be exposed beyond a trusted local host, impose a transport
or schema size limit and return an MCP input error before parsing.

---

## Response to code review: round 2

Written by the implementer after acting on the findings above. This section is the convention
for every future review round: findings stay as written, and the response is appended here
rather than replacing them, so a later reader can see what was claimed, what was verified, and
what was decided.

Each finding below records the reproduction actually run, the disposition, and the commit.
Where a finding is accepted with a correction to its framing, the correction is stated - a
disposition that quietly restates a finding is not a response to it.

### P1 — cancellation can still return a successful result: CONFIRMED, fixed

Reproduced against the built code exactly as described: one citation, the controller aborted
during its own lookup, `{ "calls": 1, "status": "resolved" }` rather than a rejection.

The finding is right that this contradicts the stated contract - the commit that introduced
cancellation claimed a cancelled call "returns no result at all", and the code did not deliver
that. Fixed by checking the signal once more after the sweep's loop, since the in-loop check is
a boundary and the final citation has no boundary after it. Both the single-citation and the
last-of-several shapes are pinned; the pre-existing tests covered abort-before-start and
abort-before-the-next-citation, neither of which can see this gap.

One correction to the severity: this cost no additional backend call. The work for the final
citation had already been done, so the defect is an inconsistency between the published
contract and the code, not wasted spend.

Commit: `c1b7387`.

### P1 — cancellation does not reach a paginated node-structure lookup: CONFIRMED, fixed

Reproduced: with the signal aborted while part 1 was being fetched, `accumulateNodeIds` went on
to fetch all six parts of a six-part outline. The finding is also right that the
distinct-document cap cannot mitigate it - that cap bounds documents, not parts.

This was the substantive finding of the round. `DocLookup` now takes an optional
`AbortSignal`, checked before every structure part and passed to `callTool`, so a request
already on the wire aborts instead of waiting out the SDK's 60-second default. The parameter is
optional so an existing implementation stays valid, with a stated interface contract that an
implementation honouring it must let the cancellation escape as a throw - never as a
found/not-found verdict and never as a partial node-id set, for the same reason the pagination
cap throws rather than truncating.

The instruction to preserve the safety invariant was the load-bearing part of this finding, and
it required work beyond the propagation itself. Both lookup catches in `src/resolver.ts`
convert a throw into `unchecked`, which is what keeps a backend outage from reading as
`unresolved`; a cancellation raised inside a lookup would therefore have come back out of those
catches as a verdict, and the cancelled call would have returned a result full of `unchecked`
entries that looks like an answer - worse than the defect being fixed. Both now re-throw on an
aborted signal before converting and before logging. Before logging matters independently: that
stderr line is the only signal an operator gets for a real outage, so one entry per document on
every cancellation would bury exactly what it exists to surface. The catches consult the
SIGNAL's state rather than the error's type, because `PageindexHttpClient` re-throws a
sanitized plain `Error` and an `AbortError`'s identity does not survive that.

A live-but-unaborted signal still turns a real lookup failure into `unchecked`, pinned by test
so this cannot decay into "any throw rejects".

Measured after the fix, on the 2550-call scenario the finding describes: 1 document lookup and
3 structure parts before the rejection.

Commit: `762ca99`.

### P2 — the name-echo fix weakens the exact-name contract for Unicode: ACCEPTED, guard tightened

Accepted, and the original justification for normalizing was wrong rather than merely
under-evidenced.

The NFC comparison was defended on the grounds that raw equality would make every accented name
a permanent `unchecked` wherever names are stored decomposed. That scenario cannot occur under
the contract the guard enforces. Matching is literal, so a request for a composed name against a
decomposed stored name returns NOT_FOUND - the guard never runs, because there is no success to
check. The only way an echo comes back in a different normal form is a backend that did not
match literally, which is precisely the behaviour the guard exists to catch.

The finding's observation that the repository provides no backend evidence either way is
correct, and the asymmetry of the two failure directions settles the choice without needing
that evidence first: raw equality can at worst report a real document `unchecked` - visible,
safe, nothing deleted, recoverable - while normalizing can at worst confirm a document under a
name the author never wrote.

Now raw code-unit equality. The comment records what would have to be OBSERVED to loosen it
(upload a decomposed name, request the other normal form, record whether it is found and what
`name` returns) and that finding the backend normalizes would be a change to the published
"literal file name" contract, not a change to this comparison alone.

Commit: `8019666`.

### Residual accepted risk — no input-size cap: ACCEPTED, cap added

Accepted, and this was the most useful item in the round, because its argument is not the one
that was weighed when the cap was declined.

The cap was declined on parse TIME, which is genuinely cheap and remains so. The finding's
argument is about MEMORY and about ordering: the grammar allocates several `Uint8Array` masks
sized to the input before any lookup happens, so the distinct-document cap cannot help. Local
measurement agrees - a 4.8 MiB input costs about 68 MiB of heap, roughly a 14x multiplier - and
the earlier reasoning simply did not address it.

`text` is now capped at 1048576 characters in the input SCHEMA rather than in the handler, so
validation refuses an oversized call before the parser allocates anything. The limit and the
remedy are published on the `text` parameter's own description rather than in the tool
description, so a caller does not have to learn the limit by tripping it, and the tool
description does not grow. The refusal surfaces as an MCP error, a failure surface the tool
description already covers: every citation is then `unchecked`, never `unresolved`.

The finding's framing of this as a deployment question ("if this server will be exposed beyond a
trusted local host") is reasonable, but a bound that costs one schema clause is cheaper than a
documented assumption about who may call the server.

Commit: `0776848`.

### Disposition table: agreed, with one note

Every row is accurate as written. One note on the four-word row: the example given,
`"Q3 Financial Results Final Draft.pdf"` being checked as `Draft.pdf`, is exactly right and is
the reason this is recorded in `CLAUDE.md` as a measured and accepted trade rather than as an
oversight. There is no structural discriminator - five words of letters and spaces is what an
ordinary quoted sentence looks like, and suppressing the span would silence the real bare name
inside every prose quotation, which is a defect an earlier round fixed. Reopening it means
choosing which of the two to accept, not finding a way to avoid both.

### Verification after this round

- `npm test`: 455 passed, 8 skipped.
- `npm run typecheck`, `npm run build`, `npm pack --dry-run`: pass.
- Every fix in this round was mutation-checked: the pagination check, the `callTool` forward,
  the catch re-throw, the post-loop check, the schema `.max()`, and both published figures
  (the distinct-document cap and the input cap) each turn their own tests red when removed or
  altered.

---

## Code review: round 3 — audit of the implementer response

**Scope:** `0abc1eab049fdc4d438d99b5ed779554626ec5b6..0776848` and the implementer
response above.

### Verification performed

- `npm test`: 455 passed, 8 skipped.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm pack --dry-run`: passed.
- `git diff --check HEAD`: passed.

### What is actually fixed

- The final/only-citation cancellation gap is fixed. `verifyCitations` now checks the
  signal after the loop, and the two regression tests cover the only-citation and
  last-of-many cases.
- Cancellation between structure pages is fixed. `accumulateNodeIds` checks the signal
  before each new page and the test proves that cancellation after part 1 does not fetch
  part 2.
- The name-echo comparison is now raw equality, consistent with the documented literal,
  case-sensitive name contract.
- The `text` schema now rejects input beyond 1,048,576 JavaScript string code units before
  the grammar allocates its linear-size masks. The boundary and no-lookup behavior are
  tested.

### P1 — `callTool(..., { signal })` does **not** abort the in-flight HTTP request in this SDK

The response and code claim that passing the signal as the third `Client.callTool` argument
aborts a request already on the wire:

> “The signal goes to the transport so a request ALREADY on the wire is aborted.”

That is not what `@modelcontextprotocol/sdk` 1.30.0 does. `Client.callTool` forwards the
third argument to `Protocol.request`. On abort, `Protocol.request` removes its response
handler, rejects its promise, and sends an MCP `notifications/cancelled` message. It does
not pass that signal to `StreamableHTTPClientTransport.send`.

The HTTP transport builds its `fetch` request with its own private
`this._abortController?.signal`, which is aborted only when the whole transport is closed.
The request-specific `RequestOptions.signal` is never used as the fetch signal. Therefore
the current fix makes the local resolver stop waiting and prevents later pagination pages,
but it cannot truthfully promise that the already-dispatched PageIndex HTTP request is
aborted or that the backend stops spending work. Backend cooperation with the MCP
`notifications/cancelled` notification is possible, but it has not been observed or tested.

The new unit tests only spy on a fake `ToolCaller` and prove that the signal object reaches
the `callTool` *API*. They do not prove the SDK transport aborts fetch, so they cannot guard
the claim made in code, documentation, or the implementer response.

**Required resolution:** either:

1. revise the code comments, `CLAUDE.md`, README, and response to say precisely what is
   guaranteed: local cancellation, no subsequent structure pages, and an MCP cancellation
   notification; or
2. use a transport/client implementation that owns a per-request `AbortController` and has
   an integration test proving that abort reaches the HTTP fetch; or
3. obtain and document PageIndex evidence that it honours `notifications/cancelled`, then
   describe this as cooperative server cancellation rather than client-side HTTP abortion.

Do not retain the current “instead of waiting out the SDK's 60-second default” claim. It is
not supported by the installed SDK's implementation.

### Response quality

The response correctly distinguishes verified fixes from accepted trade-offs and, notably,
reversed the Unicode-normalization decision rather than defending an unsupported assumption.
The in-flight-abort assertion is the remaining exception: it mistakes request-level MCP
cancellation for cancellation of the underlying HTTP fetch. This is a semantic gap, not a
stylistic one, because the stated goal was to stop quota-consuming work after the host gives
up.

---

## Response to code review: round 3

Same convention as round 2: the findings above stand as written, and this section is appended
rather than editing them.

### P1 — `callTool(..., { signal })` does not abort the in-flight HTTP request: CONFIRMED

The finding is correct, and it is correct about the specific mechanism. Verified line by line
against the installed `@modelcontextprotocol/sdk` 1.30.0 rather than taken on trust:

- `shared/protocol.js` — the abort listener calls `cancel(reason)`, which deletes the response
  handler, clears the timeout, sends `notifications/cancelled`, and rejects. `options.signal` is
  never passed to `transport.send`.
- `client/streamableHttp.js:291` — `send(message, options)` destructures only `resumptionToken`
  and `onresumptiontoken` from its options.
- `client/streamableHttp.js:305` (and 93, 443) — every fetch is built with
  `signal: this._abortController?.signal`.
- `client/streamableHttp.js:286` — that controller is aborted only in `close()`.

So the request already dispatched runs to completion and the backend keeps working on it. The
claim in the code comment was wrong, and the finding's observation about the tests is the more
important half: spying on a fake `ToolCaller` proves the signal object reaches an API, which
cannot guard a statement about what the transport then does with it. That is the same failure as
the Unicode assumption in round 2 - an assertion where an observation was needed.

Resolution 1 was taken, with the measurement the finding asked for added rather than only the
retraction. Measured through the real SDK, an aborted `callTool`:

- rejects the pending call in about 20 ms instead of waiting up to the 60-second request
  timeout, and
- delivers `notifications/cancelled` to the peer.

Both are now pinned by tests that hang to timeout when the signal is not passed, so the
surviving claims are guarded rather than merely rewritten. Those tests also record an ordering
worth knowing: aborting before the request is dispatched cancels a request the peer never saw,
so the notification only reaches the peer for a request already sent.

One nuance on the retraction. "Instead of waiting out the SDK's 60-second default" was true as a
statement about the LOCAL wait, and it matters here: without it the sweep would sit inside a
single `await` for up to a minute per document before its own abort checks could run. What was
false was the conflation - presenting a local rejection plus a notification as cancellation of
the backend's work. The comments now separate the two explicitly, and the residual cost is
stated as what it is: one in-flight request per cancellation completes and is billed, and the
backend's response to the notification is unverified.

Resolutions 2 and 3 were considered and declined, with reasons:

- Owning a transport with a per-request `AbortController` means reimplementing the HTTP client
  and its auth plumbing to save one request per cancellation. The thousands-of-calls problem is
  already stopped by the pagination and resolver checks; this would buy a bounded, single-request
  improvement at the cost of a load-bearing component the SDK currently owns.
- Documenting PageIndex's handling of `notifications/cancelled` needs a live probe that has not
  been run. Rather than describe unobserved cooperative cancellation, the README now says the
  notification is sent and its effect is not verified, which is the honest state.

Commit: `dddb171`.

### Response quality note: acknowledged

The observation that this was a semantic gap rather than a stylistic one is accepted, and the
pattern is worth naming because it has now happened twice. Both round-2's Unicode normalization
and round-3's in-flight abort were confident statements about a dependency's behaviour that no
test could contradict, written in a codebase whose stated rule is to verify against the source
of truth rather than assert. The corrective added this round is not just the retraction: it is
that the two surviving claims about the SDK are now pinned by tests which fail if the SDK's
behaviour changes, so the next reader inherits observations rather than assertions.

### Verification after this round

- `npm test`: 458 passed, 8 skipped.
- `npm run typecheck`, `npm run build`, `npm pack --dry-run`: pass.
- Mutation-checked: removing the signal from `callTool` hangs both new SDK tests to timeout, and
  deleting the README's "not been verified" qualifier turns the prose guard red.
