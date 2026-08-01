// test/integration.test.ts
//
// Exercises verifyCitations against the REAL backend, via a real PageindexHttpClient -
// the only place in the suite that touches the network. Credential-gated: skipped
// entirely unless BOTH PAGEINDEX_API_KEY and CITATION_VERIFY_TEST_DOC_NAME are set, so an
// absent credential is a clean skip, never a failure (docs/rework-plan.md Task R6).
//
// Environment contract:
//   PAGEINDEX_API_KEY             - a live key.
//   CITATION_VERIFY_TEST_DOC_NAME - the exact, case-sensitive file name (with extension)
//                                    of a document that really exists in that account.
//   CITATION_VERIFY_TEST_NODE_ID  - optional; a node id that really exists in that
//                                    document's outline. When absent, the node-present
//                                    assertion is skipped rather than guessed at.
//
// No document name, page count, node id, or other corpus-specific value is hardcoded
// anywhere below - everything real comes from the environment. A fabricated name/id
// used to probe the not-found path is invented and neutral by construction, never a
// real corpus value.
//
// SECURITY: the key is read from process.env only. Never log, print, or interpolate it
// into an assertion message - a failed assertion's message is the one place a stray
// key value could leak into CI output. In particular, never derive a "wrong" key from
// the real one (a wrong key must be an independent fabricated constant) and never hand
// a Promise that might resolve to something carrying the key (directly or nested inside
// an object) to `expect(...)` - vitest serializes the resolved/actual value into the
// failure diff, and `private` fields are not runtime-private, so a client instance
// reachable from `actual` could still walk down to a header carrying the key.
//
// CI note: several assertions below embed the real, operator-supplied document name
// (from CITATION_VERIFY_TEST_DOC_NAME) in their failure diff on a failing run. That name
// is not a secret and not a hardcode violation, but is real corpus data - be aware
// before pointing this file at shared CI output.
//
// Note on structure: `describe`'s factory function runs synchronously during test
// COLLECTION regardless of `describe.runIf`'s condition - only its child tests/hooks
// are actually skipped. So the env values are never narrowed once at the top of the
// describe body (that would throw during collection on every run, gate or no gate);
// instead each test/hook narrows what it needs, lazily, inside its own callback - those
// callbacks are only invoked when the test genuinely runs.
import { describe, it, expect, beforeAll } from "vitest";
import { verifyCitations } from "../src/resolver.js";
import { PageindexHttpClient } from "../src/pageindex-client.js";
import type { DocLookup } from "../src/pageindex-client.js";

// Trimmed at the read site, matching src/index.ts - a key supplied with a trailing
// newline should fail integration tests for the same reason it would fail production
// (an invalid header value), not for a reason unique to this file.
const apiKey = process.env["PAGEINDEX_API_KEY"]?.trim();
const realDocName = process.env["CITATION_VERIFY_TEST_DOC_NAME"];
const realNodeId = process.env["CITATION_VERIFY_TEST_NODE_ID"];

// Narrows an optional env value to a definite string, at the point of use inside a
// test/hook body. Only reachable with `value === undefined` if the describe.runIf /
// it.runIf gate above it did not do its job - in normal operation this never throws.
function requireEnv(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new Error(`${name} was not set even though the run-gate for this test claimed it was.`);
  }
  return value;
}

// The real document name comes from the environment and is not under this test's
// control - it may contain spaces or punctuation that the grammar's bare (unquoted)
// pattern cannot reliably span (see src/grammar.ts: DOC_NAME_PATTERN excludes spaces).
// Wrapping it in double quotes routes it through the grammar's quoted-name path
// instead, which reads it verbatim regardless of spaces. The canonical token produced
// is the same either way - quoting only changes how the name is matched in prose, not
// what it resolves to.
function quoted(name: string): string {
  return `"${name}"`;
}

// A name that cannot plausibly collide with a real corpus entry - fabricated, neutral,
// never a real consuming-host or domain-specific value.
const FABRICATED_DOC_NAME = "does-not-exist-zzz-0000.pdf";
const FABRICATED_NODE_ID = "zzz-not-a-real-node-9999";

// An independently fabricated key for the "wrong credential" test below - NEVER derived
// from the real key. A key derived from the real one (e.g. `${realKey}-suffix`) would
// both send a one-suffix-away copy of a live credential over the wire into the
// backend's rejected-credential logs, and - if `connect` ever regressed to resolving
// instead of rejecting - hand a value carrying the real key to `expect(...)`, which
// vitest would serialize into the failure diff.
const FABRICATED_API_KEY = "not-a-real-key-zzz-0000";

// Real network round trips (get_document, get_document_structure, possibly multiple
// pages of the latter) can take a while against the live backend.
const NETWORK_TIMEOUT_MS = 60_000;

describe.runIf(Boolean(apiKey) && Boolean(realDocName))("integration: real PageIndex backend", () => {
  let client: DocLookup;

  beforeAll(async () => {
    client = await PageindexHttpClient.connect(requireEnv(apiKey, "PAGEINDEX_API_KEY"));
  }, NETWORK_TIMEOUT_MS);

  it(
    "resolves a citation to a document that really exists",
    async () => {
      const docName = requireEnv(realDocName, "CITATION_VERIFY_TEST_DOC_NAME");
      const result = await verifyCitations(`See ${quoted(docName)} for details.`, client);
      const detail = result.details.find((d) => d.token === docName);
      expect(detail).toBeDefined();
      expect(detail?.status).toBe("resolved");
      expect(detail?.title).toBe(docName);
    },
    NETWORK_TIMEOUT_MS,
  );

  it(
    "reports a fabricated document name as unresolved, never unchecked",
    async () => {
      const result = await verifyCitations(`See ${FABRICATED_DOC_NAME} for details.`, client);
      const detail = result.details.find((d) => d.token === FABRICATED_DOC_NAME);
      expect(detail).toBeDefined();
      // This is the assertion that proves the tool can actually catch a fabricated
      // citation: a real absence must land on `unresolved`, not on `unchecked` (which
      // would mean "could not check" and leave the fabrication looking untouched).
      expect(detail?.status).toBe("unresolved");
      // Documentation only, not additional coverage: given the `.toBe("unresolved")`
      // above, `CitationStatus` has exactly one other failing value this could take, so
      // this line is unreachable once the one above passes. Kept for a reader scanning
      // this test in isolation.
      expect(detail?.status).not.toBe("unchecked");
    },
    NETWORK_TIMEOUT_MS,
  );

  it(
    "reports a page beyond the document's real page count as unresolved, with an in-range page as a positive control",
    async ({ skip }) => {
      const docName = requireEnv(realDocName, "CITATION_VERIFY_TEST_DOC_NAME");
      const doc = await client.getDocument(docName);
      // Asserted, not just branched on: a regression that makes getDocument stop
      // finding the real document must fail this test loudly, not silently reduce it
      // to a no-op via the early return below.
      expect(doc.found).toBe(true);
      if (!doc.found) return; // unreachable once the assertion above holds; narrows for TS
      if (doc.doc.pageCount === null) {
        // The real page count is not available from the backend for this
        // account/document - nothing to bounds-check against. A vitest SKIP, not a
        // silent pass: an `interpretGetDocument` regression that always yields
        // `pageCount: null` must show up as skipped, not as a green no-op.
        skip();
        return;
      }
      const pageCount = doc.doc.pageCount;

      // Positive control: page 1 is in range for any document with a known page count
      // (pageCount is only ever a positive integer - see interpretGetDocument), so this
      // must resolve. Without this, an implementation that marks every page-bearing
      // citation unresolved would still pass the out-of-range assertion below.
      const inRangeResult = await verifyCitations(`See ${quoted(docName)} p.1.`, client);
      const inRangeToken = `${docName}#p1`;
      const inRangeDetail = inRangeResult.details.find((d) => d.token === inRangeToken);
      expect(inRangeDetail).toBeDefined();
      expect(inRangeDetail?.status).toBe("resolved");

      const outOfRangePage = pageCount + 1000;
      const result = await verifyCitations(`See ${quoted(docName)} p.${outOfRangePage}.`, client);
      const token = `${docName}#p${outOfRangePage}`;
      const detail = result.details.find((d) => d.token === token);
      expect(detail).toBeDefined();
      expect(detail?.status).toBe("unresolved");
    },
    NETWORK_TIMEOUT_MS,
  );

  it(
    "reports a fabricated node id in a real document as unresolved",
    async () => {
      const docName = requireEnv(realDocName, "CITATION_VERIFY_TEST_DOC_NAME");
      const result = await verifyCitations(`${quoted(docName)}, node_id: ${FABRICATED_NODE_ID}`, client);
      const token = `${docName}#n${FABRICATED_NODE_ID}`;
      const detail = result.details.find((d) => d.token === token);
      expect(detail).toBeDefined();
      expect(detail?.status).toBe("unresolved");
    },
    NETWORK_TIMEOUT_MS,
  );

  // Positive control for node resolution, unconditional (unlike the CITATION_VERIFY_TEST_NODE_ID-
  // gated test below). Partly self-referential by construction: the "real" node id used
  // here is read from `client.getNodeIds(docName)`, the very call being validated, so a
  // getNodeIds that always returned an empty set convincingly would not be caught by
  // this test alone - the env-gated test below is the independent check for that. This
  // test SKIPS (not fails) when the structure lookup itself throws or yields no ids, since
  // that is a property of the operator's chosen document, not a regression to report on.
  it(
    "resolves a citation to a real node id read from the document's own structure (self-referential positive control)",
    async ({ skip }) => {
      const docName = requireEnv(realDocName, "CITATION_VERIFY_TEST_DOC_NAME");
      let ids: Set<string>;
      try {
        ids = await client.getNodeIds(docName);
      } catch {
        skip();
        return;
      }
      const [firstId] = ids;
      if (firstId === undefined) {
        skip();
        return;
      }
      const result = await verifyCitations(`${quoted(docName)}, node_id: ${firstId}`, client);
      const token = `${docName}#n${firstId}`;
      const detail = result.details.find((d) => d.token === token);
      expect(detail).toBeDefined();
      expect(detail?.status).toBe("resolved");
    },
    NETWORK_TIMEOUT_MS,
  );

  it(
    "reports a bare node_id with no document as unchecked, without touching the backend",
    async () => {
      // Uses a COUNTING client, not the real one - passing a client whose calls throw
      // would also yield `unchecked` (see the outage-invariant test below), so it would
      // not actually discriminate "never called" from "called and failed". Only a call
      // count proves the backend was never touched, which is what this test's name claims.
      let getDocumentCalls = 0;
      let getNodeIdsCalls = 0;
      const countingClient: DocLookup = {
        async getDocument() {
          getDocumentCalls++;
          throw new Error("should never be called: a bare node_id with no document is unverifiable by construction");
        },
        async getNodeIds() {
          getNodeIdsCalls++;
          throw new Error("should never be called: a bare node_id with no document is unverifiable by construction");
        },
      };
      const result = await verifyCitations(`node_id: ${FABRICATED_NODE_ID}`, countingClient);
      const token = `node_id:${FABRICATED_NODE_ID}`;
      const detail = result.details.find((d) => d.token === token);
      expect(detail).toBeDefined();
      expect(detail?.status).toBe("unchecked");
      expect(getDocumentCalls).toBe(0);
      expect(getNodeIdsCalls).toBe(0);
    },
  );

  it.runIf(Boolean(realNodeId))(
    "resolves a citation to a node that really exists in the document",
    async () => {
      const docName = requireEnv(realDocName, "CITATION_VERIFY_TEST_DOC_NAME");
      const nodeId = requireEnv(realNodeId, "CITATION_VERIFY_TEST_NODE_ID");
      const result = await verifyCitations(`${quoted(docName)}, node_id: ${nodeId}`, client);
      const token = `${docName}#n${nodeId}`;
      const detail = result.details.find((d) => d.token === token);
      expect(detail).toBeDefined();
      expect(detail?.status).toBe("resolved");
    },
    NETWORK_TIMEOUT_MS,
  );

  // THE LOAD-BEARING INVARIANT (CLAUDE.md hard rule 4). A client built with a
  // deliberately wrong key must never let a real absence and a backend/auth failure be
  // confused: an outage or bad credential must produce `unchecked`, never
  // `unresolved` - otherwise a consuming agent would delete good citations during an
  // outage. Per docs/spike-b-findings.md section 2, a bad key fails at `connect` itself
  // with a transport-level throw, so that is asserted directly. The second half proves
  // the same guarantee holds one layer up, through verifyCitations, using a DocLookup
  // whose calls throw exactly the way a live client would after a failed connect - this
  // does not touch the network, it exercises the resolver's contract with any client
  // that cannot complete a check.
  it(
    "never reports unresolved for a client that cannot authenticate - the outage invariant",
    async () => {
      const docName = requireEnv(realDocName, "CITATION_VERIFY_TEST_DOC_NAME");

      // Deliberately NOT derived from the real key (see FABRICATED_API_KEY above) and
      // deliberately NOT handed to `expect(...)` as a Promise: if `connect` ever
      // regressed to resolving instead of rejecting, the resolved value would be a
      // PageindexHttpClient, and `private` is not runtime-private - vitest would
      // serialize it into the failure diff. Only a boolean ever reaches `expect`.
      let connected = false;
      try {
        await PageindexHttpClient.connect(FABRICATED_API_KEY);
        connected = true;
      } catch {
        // Expected: a key the backend rejects must fail at connect.
      }
      expect(connected).toBe(false);

      const throwingClient: DocLookup = {
        async getDocument() {
          throw new Error("simulated: could not connect with an invalid key");
        },
        async getNodeIds() {
          throw new Error("simulated: could not connect with an invalid key");
        },
      };
      const result = await verifyCitations(`See ${quoted(docName)} for details.`, throwingClient);
      const detail = result.details.find((d) => d.token === docName);
      expect(detail).toBeDefined();
      expect(detail?.status).toBe("unchecked");
      // Documentation only, not additional coverage - see the equivalent note on the
      // fabricated-document-name test above; unreachable once the assertion above passes.
      expect(detail?.status).not.toBe("unresolved");
      expect(result.unresolved).toEqual([]);
    },
    NETWORK_TIMEOUT_MS,
  );
});
