// test/pageindex-client.test.ts
import { describe, it, expect } from "vitest";
import { interpretGetDocument, collectNodeIds, shouldFetchNextStructurePart } from "../src/pageindex-client.js";

// Builds a minimal CallToolResult-shaped envelope: a single text content block whose
// text is the JSON-stringified body, matching what the SDK's Client.callTool() returns
// (see node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.d.ts).
function textResult(body: unknown, isError = false): unknown {
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError };
}

describe("interpretGetDocument", () => {
  // Shapes below are taken verbatim from docs/spike-b-findings.md section 4.
  it("reports a found document from a success body", () => {
    const res = textResult({
      success: true,
      name: "some-doc.pdf",
      description: "A test document",
      status: "completed",
      created_at: "2026-01-01T00:00:00Z",
      page_count: 56,
      folder_id: null,
    });
    expect(interpretGetDocument(res)).toEqual({
      found: true,
      doc: { name: "some-doc.pdf", pageCount: 56 },
    });
  });

  it("reports pageCount null when page_count is missing (still found)", () => {
    const res = textResult({ success: true, name: "some-doc.pdf", status: "completed" });
    expect(interpretGetDocument(res)).toEqual({
      found: true,
      doc: { name: "some-doc.pdf", pageCount: null },
    });
  });

  it("reports pageCount null when page_count is not a number", () => {
    const res = textResult({ success: true, name: "some-doc.pdf", page_count: "56" });
    expect(interpretGetDocument(res)).toEqual({
      found: true,
      doc: { name: "some-doc.pdf", pageCount: null },
    });
  });

  it("reports not found with the similar file list populated", () => {
    const res = textResult(
      {
        error: 'Document not found. Did you mean: "some-doc.pdf"?',
        errorCode: "NOT_FOUND",
        doc_name: "some-dc.pdf",
        similar_files: ["some-doc.pdf"],
      },
      true,
    );
    expect(interpretGetDocument(res)).toEqual({ found: false, similar: ["some-doc.pdf"] });
  });

  it("reports not found with an empty similar file list", () => {
    const res = textResult(
      { error: "Document not found.", errorCode: "NOT_FOUND", doc_name: "missing.pdf", similar_files: [] },
      true,
    );
    expect(interpretGetDocument(res)).toEqual({ found: false, similar: [] });
  });

  it("reports not found when similar_files is missing entirely", () => {
    const res = textResult(
      { error: "Document not found.", errorCode: "NOT_FOUND", doc_name: "missing.pdf" },
      true,
    );
    expect(interpretGetDocument(res)).toEqual({ found: false, similar: [] });
  });

  // The trap Spike B found: isError is the SAME channel as a backend failure. Only a
  // POSITIVE NOT_FOUND code may become `unresolved`; anything else must throw so it
  // becomes `unchecked` (CLAUDE.md hard rule 4).
  it("throws on an isError body with a different errorCode", () => {
    const res = textResult({ error: "Invalid arguments", errorCode: "VALIDATION_ERROR" }, true);
    expect(() => interpretGetDocument(res)).toThrow();
  });

  it("throws on an isError body that is not JSON", () => {
    const res = {
      content: [
        {
          type: "text",
          text: "Invalid arguments for tool get_document: doc_name ... expected string, received undefined",
        },
      ],
      isError: true,
    };
    expect(() => interpretGetDocument(res)).toThrow();
  });

  it("throws on an empty or garbage envelope", () => {
    expect(() => interpretGetDocument({})).toThrow();
    expect(() => interpretGetDocument(null)).toThrow();
    expect(() => interpretGetDocument({ content: [] })).toThrow();
    expect(() => interpretGetDocument("garbage")).toThrow();
  });

  it("bounds the thrown message length for a huge payload", () => {
    const huge = { content: [{ type: "text", text: "x".repeat(5000) }], isError: false };
    let message: string | null = null;
    try {
      interpretGetDocument(huge);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toBeNull();
    // Bounds the WHOLE message: well above the excerpt cap plus its prefix, far below
    // the 5000-character payload. Removing the cap blows straight through this.
    expect(message?.length ?? 0).toBeLessThan(400);
    // Still diagnosable, and visibly marked as truncated.
    expect(message).toMatch(/x{50}/);
    expect(message).toMatch(/\.\.\.$/);
  });
});

describe("collectNodeIds", () => {
  it("collects ids from a flat structure", () => {
    const structure = [
      { title: "Intro", node_id: "0000", start_index: 1, end_index: 1, summary: "..." },
      { title: "Body", node_id: "0001", start_index: 2, end_index: 5, summary: "..." },
    ];
    expect(collectNodeIds(structure)).toEqual(new Set(["0000", "0001"]));
  });

  it("collects ids from a nested structure", () => {
    const structure = [
      { title: "Intro", node_id: "0000", start_index: 1, end_index: 1 },
      {
        title: "Chapter",
        node_id: "0002",
        start_index: 6,
        end_index: 6,
        nodes: [{ title: "Section", node_id: "0003", start_index: 6, end_index: 6 }],
      },
    ];
    expect(collectNodeIds(structure)).toEqual(new Set(["0000", "0002", "0003"]));
  });

  it("returns an empty set for an empty structure", () => {
    expect(collectNodeIds([])).toEqual(new Set());
  });

  // A partial set would make a real node id look absent and produce a false
  // `unresolved`, so a shape that cannot be read must throw, not be skipped.
  it("throws on a malformed entry missing node_id", () => {
    expect(() => collectNodeIds([{ title: "Intro" }])).toThrow();
  });

  it("throws when the structure itself is not an array", () => {
    expect(() => collectNodeIds({ not: "an array" })).toThrow();
  });
});

// Probed live against a real 56-page single-part document: the backend OMITS
// `pagination` entirely when the outline fits in one part - it is not
// `{has_more:false}`, the key does not exist at all. Absence must mean "last part",
// not "unreadable, throw" - otherwise node verification is dead on arrival for every
// normal (single-part) document, since a missing pagination block would be treated as
// ambiguous and every node check would come back `unchecked`.
describe("shouldFetchNextStructurePart", () => {
  it("stops when pagination is absent (undefined) - the observed single-part shape", () => {
    expect(shouldFetchNextStructurePart(undefined)).toBe(false);
  });

  it("stops when pagination.has_more is explicitly false", () => {
    expect(shouldFetchNextStructurePart({ has_more: false })).toBe(false);
  });

  it("continues only when pagination.has_more is literal true", () => {
    expect(shouldFetchNextStructurePart({ has_more: true })).toBe(true);
  });

  it("stops when pagination is not an object", () => {
    expect(shouldFetchNextStructurePart(null)).toBe(false);
    expect(shouldFetchNextStructurePart("has_more")).toBe(false);
    expect(shouldFetchNextStructurePart(42)).toBe(false);
  });

  it("stops when has_more is present but not literal true", () => {
    expect(shouldFetchNextStructurePart({ has_more: "true" })).toBe(false);
    expect(shouldFetchNextStructurePart({ has_more: 1 })).toBe(false);
    expect(shouldFetchNextStructurePart({})).toBe(false);
  });
});
