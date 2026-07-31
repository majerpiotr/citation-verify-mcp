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

  it("preserves first-seen order across both patterns", () => {
    const text = "As stated in report.pdf p.5 then node_id: abc-123 later.";
    expect(extractCitations(text)).toEqual(["report.pdf#p5", "abc-123"]);
  });

  it("matches p. with a space before the page number", () => {
    const text = "See report.pdf p. 5 for details.";
    expect(extractCitations(text)).toEqual(["report.pdf#p5"]);
  });

  it("matches a comma between the document name and the page marker", () => {
    const text = "See report.pdf, p.5 for details.";
    expect(extractCitations(text)).toEqual(["report.pdf#p5"]);
  });

  it("does not swallow a sentence-final period into a node_id token", () => {
    const text = "The source is node_id: abc-123.";
    expect(extractCitations(text)).toEqual(["abc-123"]);
  });

  it("does not swallow a trailing bracket into a node_id token", () => {
    const text = "(node_id: abc-123)";
    expect(extractCitations(text)).toEqual(["abc-123"]);
  });

  it("supports a page range", () => {
    const text = "See report.pdf p.5-7 for details.";
    expect(extractCitations(text)).toEqual(["report.pdf#p5-7"]);
  });

  it("drops a token that is empty once trailing punctuation is stripped", () => {
    // An ellipsis placeholder must not become an empty docName sent to the backend, nor
    // an empty token inflating `total`.
    expect(extractCitations("node_id: ...")).toEqual([]);
    expect(extractCitations("node_id: ). node_id: abc-123")).toEqual(["abc-123"]);
  });

  it("does not truncate a dotted document name", () => {
    const text = "See annual.report.pdf page 5.";
    expect(extractCitations(text)).toEqual(["annual.report.pdf#p5"]);
  });
});

describe("splitToken", () => {
  it("splits a page token without doubling .pdf", () => {
    expect(splitToken("report.pdf#p5")).toEqual({ docName: "report.pdf", pages: "5" });
  });
  it("returns bare token as docName with null pages", () => {
    expect(splitToken("some-doc-id-123")).toEqual({ docName: "some-doc-id-123", pages: null });
  });
  it("splits a page range token", () => {
    expect(splitToken("report.pdf#p5-7")).toEqual({ docName: "report.pdf", pages: "5-7" });
  });
  it("does not split on a # that is not a page marker", () => {
    expect(splitToken("doc#part1-x")).toEqual({ docName: "doc#part1-x", pages: null });
  });
  it("round-trips with extractCitations output", () => {
    expect(splitToken(extractCitations("See report.pdf p.5 here.")[0])).toEqual({
      docName: "report.pdf",
      pages: "5",
    });
  });
});
