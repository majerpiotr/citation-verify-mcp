// test/resolver.test.ts
//
// Exercises verifyCitations against a FAKE DocLookup - no network, no key. Every case
// below traces back to a rule in docs/rework-plan.md's Task R3 or to CLAUDE.md hard rule
// 4 (unresolved requires a positive miss; anything ambiguous is unchecked). Call counts on
// the fake are asserted explicitly wherever the per-call dedup rule applies - the dedup is
// otherwise invisible from outcomes alone.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { verifyCitations } from "../src/resolver.js";
import type { DocLookup, DocLookupResult } from "../src/pageindex-client.js";

// An `Error` value means "throw exactly this", so a test can pin what does (and does not)
// survive from a thrown message into the model-facing `suggestion` and the operator-facing
// stderr line. `"throw"` keeps the shorthand for cases where the message is irrelevant.
interface FakeConfig {
  documents?: Record<string, DocLookupResult | "throw" | Error>;
  nodeIds?: Record<string, Set<string> | "throw" | Error>;
}

interface FakeClient {
  client: DocLookup;
  getDocumentCalls: string[];
  getNodeIdsCalls: string[];
}

function fakeClient(config: FakeConfig): FakeClient {
  const getDocumentCalls: string[] = [];
  const getNodeIdsCalls: string[] = [];
  const client: DocLookup = {
    async getDocument(docName) {
      getDocumentCalls.push(docName);
      const v = config.documents?.[docName];
      if (v === "throw") throw new Error("backend down");
      if (v instanceof Error) throw v;
      if (v === undefined) throw new Error(`test fixture missing for getDocument("${docName}")`);
      return v;
    },
    async getNodeIds(docName) {
      getNodeIdsCalls.push(docName);
      const v = config.nodeIds?.[docName];
      if (v === "throw") throw new Error("backend down");
      if (v instanceof Error) throw v;
      if (v === undefined) throw new Error(`test fixture missing for getNodeIds("${docName}")`);
      return v;
    },
  };
  return { client, getDocumentCalls, getNodeIdsCalls };
}

describe("verifyCitations", () => {
  // The resolver writes one diagnostic line per distinct failing document to STDERR (never
  // stdout, which carries the MCP protocol stream). Captured rather than printed so the
  // suite stays quiet, and so the lines themselves can be asserted on.
  let errorLines: string[] = [];
  beforeEach(() => {
    errorLines = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errorLines.push(args.map((a) => String(a)).join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns an empty verdict for text with no citations", async () => {
    const { client } = fakeClient({});
    const r = await verifyCitations("plain prose with no citations at all.", client);
    expect(r).toEqual({ total: 0, resolved: 0, unresolved: [], unchecked: [], details: [] });
  });

  it("resolves a document that exists", async () => {
    const { client } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 10 } } },
    });
    const r = await verifyCitations("See report.pdf.", client);
    expect(r.details).toEqual([
      { token: "report.pdf", status: "resolved", title: "report.pdf", suggestion: null },
    ]);
    expect(r.total).toBe(1);
    expect(r.resolved).toBe(1);
  });

  it("reports a missing document as unresolved with a suggestion from the near-miss hint", async () => {
    const { client } = fakeClient({
      documents: { "typo.pdf": { found: false, similar: ["report.pdf"] } },
    });
    const r = await verifyCitations("See typo.pdf.", client);
    expect(r.details).toEqual([
      { token: "typo.pdf", status: "unresolved", title: null, suggestion: 'Did you mean "report.pdf"?' },
    ]);
    expect(r.unresolved).toEqual(["typo.pdf"]);
  });

  // Measured against the live backend: the near-name hint (`similar_files`) arrives when the
  // extension is missing or its case is wrong, but is EMPTY when the case of the name's stem
  // differs - the most likely real-world mistake. Without a hint the citation used to arrive
  // as a bare `unresolved` with no explanation, which a consuming agent acts on by deleting a
  // claim that may name a document that genuinely exists under a different capitalisation.
  // The static hint below closes that silence. It never names a document: refusing to guess
  // which one was meant is the whole premise, and the verdict stays `unresolved`.
  it("explains the miss with a static hint when there is no near-miss hint", async () => {
    const { client } = fakeClient({
      documents: { "missing.pdf": { found: false, similar: [] } },
    });
    const r = await verifyCitations("See missing.pdf.", client);
    expect(r.details).toHaveLength(1);
    const detail = r.details[0]!;
    expect(detail.token).toBe("missing.pdf");
    expect(detail.status).toBe("unresolved"); // the hint must NOT change the verdict
    expect(detail.title).toBeNull();
    expect(detail.suggestion).not.toBeNull();
    expect(detail.suggestion).toMatch(/case-sensitiv/i);
    expect(detail.suggestion).toMatch(/extension/i);
    expect(detail.suggestion).toMatch(/exact name/i);
  });

  it("keeps the no-near-miss hint static: it never names or quotes a document", async () => {
    const { client } = fakeClient({
      documents: {
        "missing.pdf": { found: false, similar: [] },
        "some-doc-name-123.PDF": { found: false, similar: [] },
      },
    });
    const r = await verifyCitations("See missing.pdf and some-doc-name-123.PDF.", client);
    const suggestions = r.details.map((d) => d.suggestion);
    // Identical for two different cited names: proof it is a constant, not a derived guess.
    expect(suggestions[0]).toBe(suggestions[1]);
    for (const s of suggestions) {
      expect(s).not.toMatch(/missing/i);
      expect(s).not.toMatch(/some-doc-name-123/i);
      expect(s).not.toMatch(/\.pdf/i);
      expect(s).not.toMatch(/"/); // no quoted string a reader could take for a real name
    }
  });

  // A failed document lookup is the single most common production failure (backend down,
  // credential rejected, unreadable response). It used to return `suggestion: null`, which
  // told a consuming agent nothing at all about why the citation could not be checked -
  // while the README promises this field explains exactly that. The verdict is unchanged:
  // still `unchecked`, still never `unresolved`.
  it("treats a getDocument throw as unchecked, never unresolved, and explains why", async () => {
    const { client } = fakeClient({ documents: { "down.pdf": "throw" } });
    const r = await verifyCitations("See down.pdf.", client);
    expect(r.unresolved).toEqual([]);
    expect(r.unchecked).toEqual(["down.pdf"]);
    expect(r.details).toHaveLength(1);
    const detail = r.details[0]!;
    expect(detail.token).toBe("down.pdf");
    expect(detail.status).toBe("unchecked");
    expect(detail.title).toBeNull(); // the document was never confirmed to exist
    expect(detail.suggestion).not.toBeNull();
    expect(detail.suggestion).toMatch(/could not be checked/i);
    // The one thing a consuming agent must not conclude from this verdict.
    expect(detail.suggestion).toMatch(/not evidence that the document is missing/i);
  });

  // The explanation is a STATIC constant on purpose. The resolver never holds the API key,
  // so it could not redact one out of a thrown message even if it wanted to - and this
  // field is handed straight to a model. Anything derived from the error goes to stderr
  // instead, where the key-holding layer has already redacted it.
  it("keeps the unchecked-document explanation static: it never quotes the thrown error", async () => {
    // Fabricated, never derived from any real key.
    const FAKE_SECRET = "pi-FAKE-SECRET-0000";
    const { client } = fakeClient({
      documents: {
        "one.pdf": new Error(`connect ECONNREFUSED, sent Authorization: Bearer ${FAKE_SECRET}`),
        "two.pdf": new Error("get_document returned a non-JSON payload: 502 Bad Gateway"),
      },
    });
    const r = await verifyCitations("See one.pdf and two.pdf.", client);
    const suggestions = r.details.map((d) => d.suggestion);
    // Identical for two failures with completely different messages: proof it is a
    // constant, not a rendering of whatever was thrown.
    expect(suggestions[0]).toBe(suggestions[1]);
    expect(suggestions[0]).not.toContain(FAKE_SECRET);
    expect(suggestions[0]).not.toMatch(/ECONNREFUSED|Bad Gateway|non-JSON/);
    // Bounded: this string goes into a model's context on every failing citation.
    expect((suggestions[0] ?? "").length).toBeLessThan(600);
  });

  // Without this, an outage, a credential pointing at the wrong account and a backend
  // schema change are indistinguishable to whoever is holding the pager: every one of them
  // produces a sweep of `unchecked` and a silent stderr. stderr (not stdout) is the only
  // legal channel here - stdout carries the MCP protocol stream.
  it("writes the underlying lookup failure to stderr, once per distinct document", async () => {
    const { client } = fakeClient({
      documents: { "down.pdf": new Error("get_document returned an unrecognized response: 503") },
    });
    const r = await verifyCitations("See down.pdf p.3 and down.pdf p.7.", client);
    expect(r.details.map((d) => d.status)).toEqual(["unchecked", "unchecked"]);
    // One line, not one per citation: the lookup itself is memoized per call.
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain("down.pdf");
    expect(errorLines[0]).toContain("unrecognized response: 503");
    // The generic "Error" name adds nothing and would read as "Error: Error: ..." once the
    // client has already rendered a cause chain into the message.
    expect(errorLines[0]).not.toMatch(/Error: Error:/);
    // A named error type IS diagnostic, so it is kept - pinned below.
  });

  it("keeps a specific error type in the stderr line", async () => {
    const { client } = fakeClient({ documents: { "down.pdf": new TypeError("fetch failed") } });
    await verifyCitations("See down.pdf.", client);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain("TypeError: fetch failed");
  });

  it("writes a node-structure lookup failure to stderr too", async () => {
    const { client } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 10 } } },
      nodeIds: {
        "report.pdf": new Error('get_document_structure for "report.pdf" exceeded the cap'),
      },
    });
    await verifyCitations("See report.pdf node_id: 0003.", client);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toContain("exceeded the cap");
  });

  // The thrown message and the cited name both originate in untrusted input (a draft an
  // agent wrote, or a response a backend sent). Neither may forge a log line with control
  // characters, and neither may flood an MCP host's log file.
  it("bounds the stderr line and strips control characters from it", async () => {
    const { client } = fakeClient({
      documents: {
        "down.pdf": new Error(`first line\n\u001b[31mFORGED ERROR\u001b[0m ${"x".repeat(3000)}`),
      },
    });
    await verifyCitations("See down.pdf.", client);
    expect(errorLines).toHaveLength(1);
    const line = errorLines[0]!;
    // eslint-disable-next-line no-control-regex
    expect(line).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(line.length).toBeLessThan(500);
  });

  it("reports a bare node id with no document as unchecked, never touching the backend", async () => {
    const { client, getDocumentCalls, getNodeIdsCalls } = fakeClient({});
    const r = await verifyCitations("node_id: 0007", client);
    expect(r.details).toHaveLength(1);
    expect(r.details[0]?.status).toBe("unchecked");
    expect(r.details[0]?.title).toBeNull();
    expect(r.details[0]?.suggestion).toMatch(/document/i);
    expect(r.details[0]?.suggestion).toMatch(/node/i);
    expect(getDocumentCalls).toEqual([]);
    expect(getNodeIdsCalls).toEqual([]);
  });

  it("resolves a citation whose page falls inside the real page count", async () => {
    const { client } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 10 } } },
    });
    const r = await verifyCitations("See report.pdf p.3.", client);
    expect(r.details).toEqual([
      { token: "report.pdf#p3", status: "resolved", title: "report.pdf", suggestion: null },
    ]);
  });

  it("reports a page beyond the real page count as unresolved with the real count in the suggestion", async () => {
    const { client } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 10 } } },
    });
    const r = await verifyCitations("See report.pdf p.99.", client);
    expect(r.details).toEqual([
      {
        token: "report.pdf#p99",
        status: "unresolved",
        title: "report.pdf",
        suggestion: "This document has 10 pages; the cited page is outside that range.",
      },
    ]);
  });

  // The two `unresolved` cases demand OPPOSITE actions from a consuming agent: fix the page
  // and keep the claim, versus find the real source or delete the claim. They used to be
  // byte-identical in every machine-readable field, leaving the distinction to an English
  // sentence a model has to read correctly. `title` carries it now: it is non-null if and
  // only if the named document was positively confirmed to exist.
  it("distinguishes a real document cited wrongly from an absent document, in a machine-readable field", async () => {
    const { client } = fakeClient({
      documents: {
        "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 10 } },
        "ghost.pdf": { found: false, similar: [] },
      },
    });
    const r = await verifyCitations("See report.pdf p.99 and ghost.pdf.", client);
    expect(r.details.map((d) => d.status)).toEqual(["unresolved", "unresolved"]);
    // The document exists; only the page missed. Fix the page, keep the claim.
    expect(r.details[0]?.title).toBe("report.pdf");
    // The document does not exist at all. Find the real source, or delete the claim.
    expect(r.details[1]?.title).toBeNull();
  });

  it("reports a page range whose upper bound is outside the page count as unresolved", async () => {
    const { client } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 10 } } },
    });
    const r = await verifyCitations("See report.pdf pp.8-12.", client);
    expect(r.details).toEqual([
      {
        token: "report.pdf#p8-12",
        status: "unresolved",
        title: "report.pdf",
        suggestion: "This document has 10 pages; the cited page is outside that range.",
      },
    ]);
  });

  // The LOWER bound is checked too, not only the upper one. Page numbering starts at 1, so
  // `p.0` names no page of any document; dropping the `lo < 1` term would let it come back
  // `resolved`, which is the one status that claims full verification.
  it("reports a cited page below the first page as unresolved", async () => {
    const { client } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 56 } } },
    });
    const r = await verifyCitations("See report.pdf p.0.", client);
    expect(r.details).toEqual([
      {
        token: "report.pdf#p0",
        status: "unresolved",
        title: "report.pdf",
        suggestion: "This document has 56 pages; the cited page is outside that range.",
      },
    ]);
  });

  it("bounds BOTH ends of a descending page range, not just the second number written", async () => {
    // "pp.99-3" parses to {from: 99, to: 3} - the grammar puts no ordering constraint on
    // the two numbers. A check that only compares `to` against pageCount lets a fabricated
    // upper endpoint slip through as a clean `resolved`, which is worse than `unchecked`:
    // resolved is the one status that claims full verification.
    const { client } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 10 } } },
    });
    const r = await verifyCitations("See report.pdf pp.99-3.", client);
    expect(r.details).toEqual([
      {
        token: "report.pdf#p99-3",
        status: "unresolved",
        title: "report.pdf",
        suggestion: "This document has 10 pages; the cited page is outside that range.",
      },
    ]);
  });

  it("does not check a cited page when the document's page count is unknown, and says so", async () => {
    const { client } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: null } } },
    });
    const r = await verifyCitations("See report.pdf p.5.", client);
    expect(r.details).toEqual([
      {
        token: "report.pdf#p5",
        status: "resolved",
        title: "report.pdf",
        suggestion: "The document's page count is not available, so the cited page could not be verified.",
      },
    ]);
  });

  it("resolves a citation whose node id is present in the document's structure", async () => {
    const { client, getNodeIdsCalls } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 10 } } },
      nodeIds: { "report.pdf": new Set(["0000", "0003"]) },
    });
    const r = await verifyCitations("See report.pdf node_id: 0003.", client);
    expect(r.details).toEqual([
      { token: "report.pdf#n0003", status: "resolved", title: "report.pdf", suggestion: null },
    ]);
    expect(getNodeIdsCalls).toEqual(["report.pdf"]);
  });

  it("reports a node id absent from the document's structure as unresolved", async () => {
    const { client } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 10 } } },
      nodeIds: { "report.pdf": new Set(["0000"]) },
    });
    const r = await verifyCitations("See report.pdf node_id: 0099.", client);
    expect(r.details).toEqual([
      {
        token: "report.pdf#n0099",
        status: "unresolved",
        title: "report.pdf",
        suggestion: 'Node "0099" was not found in this document\'s structure.',
      },
    ]);
  });

  it("treats a getNodeIds throw as unchecked, even though the document was found, and says the node was never verified", async () => {
    const { client } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 10 } } },
      nodeIds: { "report.pdf": "throw" },
    });
    const r = await verifyCitations("See report.pdf node_id: 0003.", client);
    expect(r.details).toEqual([
      {
        token: "report.pdf#n0003",
        status: "unchecked",
        title: "report.pdf",
        suggestion: "The cited node could not be verified because the document's structure could not be checked.",
      },
    ]);
    expect(r.unresolved).toEqual([]);
  });

  it("reports which half failed when a citation carries both a page and a node and only the node fails", async () => {
    const { client } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 10 } } },
      nodeIds: { "report.pdf": new Set(["0000"]) },
    });
    const r = await verifyCitations("See report.pdf p.3, node_id: 0099.", client);
    expect(r.details).toEqual([
      {
        token: "report.pdf#p3&n0099",
        status: "unresolved",
        title: "report.pdf",
        suggestion: 'Node "0099" was not found in this document\'s structure.',
      },
    ]);
  });

  it("reports which half failed when a citation carries both a page and a node and only the page fails", async () => {
    const { client } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 10 } } },
      nodeIds: { "report.pdf": new Set(["0003"]) },
    });
    const r = await verifyCitations("See report.pdf p.99, node_id: 0003.", client);
    expect(r.details).toEqual([
      {
        token: "report.pdf#p99&n0003",
        status: "unresolved",
        title: "report.pdf",
        suggestion: "This document has 10 pages; the cited page is outside that range.",
      },
    ]);
  });

  it("looks up a document shared by two citations exactly once", async () => {
    const { client, getDocumentCalls } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 10 } } },
    });
    const r = await verifyCitations("See report.pdf p.3 and report.pdf p.7.", client);
    expect(getDocumentCalls).toEqual(["report.pdf"]);
    expect(r.details.map((d) => d.token)).toEqual(["report.pdf#p3", "report.pdf#p7"]);
    expect(r.details.map((d) => d.status)).toEqual(["resolved", "resolved"]);
    expect(r.total).toBe(r.details.length);
  });

  it("fetches a document's node ids exactly once for two citations naming different nodes", async () => {
    const { client, getDocumentCalls, getNodeIdsCalls } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 10 } } },
      nodeIds: { "report.pdf": new Set(["0001", "0002"]) },
    });
    const r = await verifyCitations("report.pdf node_id: 0001. report.pdf node_id: 0002.", client);
    expect(getDocumentCalls).toEqual(["report.pdf"]);
    expect(getNodeIdsCalls).toEqual(["report.pdf"]);
    expect(r.details.map((d) => d.status)).toEqual(["resolved", "resolved"]);
    expect(r.total).toBe(r.details.length);
  });

  it("makes every citation naming a document whose lookup threw unchecked, from a single call", async () => {
    const { client, getDocumentCalls, getNodeIdsCalls } = fakeClient({
      documents: { "down.pdf": "throw" },
    });
    const r = await verifyCitations("down.pdf p.3 and down.pdf node_id: 0001.", client);
    expect(getDocumentCalls).toEqual(["down.pdf"]);
    expect(getNodeIdsCalls).toEqual([]); // step 4 never reached once the document check fails
    expect(r.details.map((d) => d.status)).toEqual(["unchecked", "unchecked"]);
    expect(r.unresolved).toEqual([]);
    expect(r.total).toBe(r.details.length);
  });

  it("never calls getNodeIds when the document itself was not found", async () => {
    const { client, getNodeIdsCalls } = fakeClient({
      documents: { "missing.pdf": { found: false, similar: [] } },
    });
    const r = await verifyCitations("See missing.pdf node_id: 0001.", client);
    expect(getNodeIdsCalls).toEqual([]);
    expect(r.details.map((d) => d.status)).toEqual(["unresolved"]);
  });

  it("combines the page-unverified note with a node-absent failure when the page count is unknown", async () => {
    const { client } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: null } } },
      nodeIds: { "report.pdf": new Set(["0000"]) },
    });
    const r = await verifyCitations("See report.pdf p.5, node_id: 0099.", client);
    expect(r.details).toEqual([
      {
        token: "report.pdf#p5&n0099",
        status: "unresolved",
        title: "report.pdf",
        suggestion:
          "The document's page count is not available, so the cited page could not be verified. " +
          'Node "0099" was not found in this document\'s structure.',
      },
    ]);
  });

  it("combines the page-unverified note with a node-unchecked note when the page count is unknown and getNodeIds throws", async () => {
    const { client } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: null } } },
      nodeIds: { "report.pdf": "throw" },
    });
    const r = await verifyCitations("See report.pdf p.5, node_id: 0003.", client);
    expect(r.details).toEqual([
      {
        token: "report.pdf#p5&n0003",
        status: "unchecked",
        title: "report.pdf",
        suggestion:
          "The document's page count is not available, so the cited page could not be verified. " +
          "The cited node could not be verified because the document's structure could not be checked.",
      },
    ]);
  });

  it("stays unresolved - never unchecked - when the page positively fails and the node lookup separately throws", async () => {
    // Adjudicated: the page miss is established against a real pageCount, so the citation
    // is demonstrably false regardless of what the node lookup would have said. Falling
    // back to `unchecked` here would let a degraded outline service launder a fabricated
    // page number into "keep this". The suggestion must still disclose that the node half
    // was never verified, since `unresolved` deletes the whole citation.
    const { client } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 10 } } },
      nodeIds: { "report.pdf": "throw" },
    });
    const r = await verifyCitations("See report.pdf p.99, node_id: 0003.", client);
    expect(r.details).toEqual([
      {
        token: "report.pdf#p99&n0003",
        status: "unresolved",
        title: "report.pdf",
        suggestion:
          "This document has 10 pages; the cited page is outside that range. " +
          "The cited node could not be verified because the document's structure could not be checked.",
      },
    ]);
  });

  it("never caches a document lookup across separate verifyCitations calls", async () => {
    const { client, getDocumentCalls } = fakeClient({
      documents: { "report.pdf": { found: true, doc: { name: "report.pdf", pageCount: 10 } } },
    });
    await verifyCitations("See report.pdf.", client);
    await verifyCitations("See report.pdf.", client);
    expect(getDocumentCalls).toEqual(["report.pdf", "report.pdf"]);
  });
});
