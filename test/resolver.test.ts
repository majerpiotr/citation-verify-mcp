// test/resolver.test.ts
//
// Exercises verifyCitations against a FAKE DocLookup - no network, no key. Every case
// below traces back to a rule in docs/rework-plan.md's Task R3 or to CLAUDE.md hard rule
// 4 (unresolved requires a positive miss; anything ambiguous is unchecked). Call counts on
// the fake are asserted explicitly wherever the per-call dedup rule applies - the dedup is
// otherwise invisible from outcomes alone.
import { describe, it, expect } from "vitest";
import { verifyCitations } from "../src/resolver.js";
import type { DocLookup, DocLookupResult } from "../src/pageindex-client.js";

interface FakeConfig {
  documents?: Record<string, DocLookupResult | "throw">;
  nodeIds?: Record<string, Set<string> | "throw">;
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
      if (v === undefined) throw new Error(`test fixture missing for getDocument("${docName}")`);
      return v;
    },
    async getNodeIds(docName) {
      getNodeIdsCalls.push(docName);
      const v = config.nodeIds?.[docName];
      if (v === "throw") throw new Error("backend down");
      if (v === undefined) throw new Error(`test fixture missing for getNodeIds("${docName}")`);
      return v;
    },
  };
  return { client, getDocumentCalls, getNodeIdsCalls };
}

describe("verifyCitations", () => {
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

  it("treats a getDocument throw as unchecked, never unresolved", async () => {
    const { client } = fakeClient({ documents: { "down.pdf": "throw" } });
    const r = await verifyCitations("See down.pdf.", client);
    expect(r.details).toEqual([{ token: "down.pdf", status: "unchecked", title: null, suggestion: null }]);
    expect(r.unresolved).toEqual([]);
    expect(r.unchecked).toEqual(["down.pdf"]);
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
        title: null,
        suggestion: "This document has 10 pages; the cited page is outside that range.",
      },
    ]);
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
        title: null,
        suggestion: "This document has 10 pages; the cited page is outside that range.",
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
        title: null,
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
        title: null,
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
        title: null,
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
        title: null,
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
        title: null,
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
        title: null,
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
        title: null,
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
        title: null,
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
