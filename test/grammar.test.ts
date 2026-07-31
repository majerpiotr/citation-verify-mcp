import { describe, it, expect } from "vitest";
import { extractCitations, splitToken } from "../src/grammar.js";

describe("extractCitations", () => {
  it("extracts node_id tokens", () => {
    const text = "See node_id: some-doc-id-123 for details.";
    expect(extractCitations(text)).toEqual(["some-doc-id-123"]);
  });

  it("extracts doc.pdf page references as doc.pdf#pN", () => {
    const text = "As stated in report.pdf p.5 and manual.pdf page 12.";
    expect(extractCitations(text)).toEqual(["report.pdf#p5", "manual.pdf#p12"]);
  });

  it("dedupes preserving first-seen order", () => {
    const text = "node_id: a node_id: b node_id: a";
    expect(extractCitations(text)).toEqual(["a", "b"]);
  });

  it("returns empty array when no citations", () => {
    expect(extractCitations("plain prose, no tokens")).toEqual([]);
  });
});

describe("splitToken", () => {
  it("splits a page token without doubling .pdf", () => {
    expect(splitToken("report.pdf#p5")).toEqual({ docName: "report.pdf", pages: "5" });
  });
  it("returns bare token as docName with null pages", () => {
    expect(splitToken("some-doc-id-123")).toEqual({ docName: "some-doc-id-123", pages: null });
  });
});
