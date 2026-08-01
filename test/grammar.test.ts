import { describe, it, expect } from "vitest";
import { extractCitations } from "../src/grammar.js";

describe("extractCitations - document only", () => {
  it("extracts a bare document mention", () => {
    expect(extractCitations("Finally report.pdf is cited with no marker.")).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
    ]);
  });

  it("does not truncate a dotted document name", () => {
    expect(extractCitations("See annual.report.pdf for details.")).toEqual([
      { token: "annual.report.pdf", docName: "annual.report.pdf", pages: null, nodeId: null },
    ]);
  });

  it("extracts two different documents in order", () => {
    expect(extractCitations("See report.pdf and manual.pdf for details.")).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
      { token: "manual.pdf", docName: "manual.pdf", pages: null, nodeId: null },
    ]);
  });

  it("treats a case variant of the same name as a distinct document (backend is case-sensitive)", () => {
    expect(extractCitations("See Report.pdf and report.pdf for details.")).toEqual([
      { token: "Report.pdf", docName: "Report.pdf", pages: null, nodeId: null },
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
    ]);
  });

  it("never emits an empty or whitespace-only document name", () => {
    expect(extractCitations("A stray .pdf mention has no name.")).toEqual([]);
  });

  it("drops a trailing period from a document name", () => {
    expect(extractCitations("The source is report.pdf.")).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
    ]);
  });
});

describe("extractCitations - document plus page", () => {
  it("matches p.<N>", () => {
    expect(extractCitations("As stated in report.pdf p.5.")).toEqual([
      { token: "report.pdf#p5", docName: "report.pdf", pages: { from: 5, to: 5 }, nodeId: null },
    ]);
  });

  it("matches p. <N> with a space", () => {
    expect(extractCitations("See report.pdf p. 5 for details.")).toEqual([
      { token: "report.pdf#p5", docName: "report.pdf", pages: { from: 5, to: 5 }, nodeId: null },
    ]);
  });

  it("matches page <N>", () => {
    expect(extractCitations("See manual.pdf page 12.")).toEqual([
      { token: "manual.pdf#p12", docName: "manual.pdf", pages: { from: 12, to: 12 }, nodeId: null },
    ]);
  });

  it("matches a page range with pp.", () => {
    expect(extractCitations("See report.pdf pp.5-7 for details.")).toEqual([
      { token: "report.pdf#p5-7", docName: "report.pdf", pages: { from: 5, to: 7 }, nodeId: null },
    ]);
  });

  it("matches a page range with pages", () => {
    expect(extractCitations("See report.pdf pages 5-7 for details.")).toEqual([
      { token: "report.pdf#p5-7", docName: "report.pdf", pages: { from: 5, to: 7 }, nodeId: null },
    ]);
  });

  it("matches keywords case-insensitively while preserving the document name's case", () => {
    expect(extractCitations("See Report.pdf PAGE 5 for details.")).toEqual([
      { token: "Report.pdf#p5", docName: "Report.pdf", pages: { from: 5, to: 5 }, nodeId: null },
    ]);
  });

  it("allows a comma between the document name and the page marker", () => {
    expect(extractCitations("See report.pdf, p.5 for details.")).toEqual([
      { token: "report.pdf#p5", docName: "report.pdf", pages: { from: 5, to: 5 }, nodeId: null },
    ]);
  });

  it("does not truncate a dotted document name with a page", () => {
    expect(extractCitations("See annual.report.pdf page 5.")).toEqual([
      { token: "annual.report.pdf#p5", docName: "annual.report.pdf", pages: { from: 5, to: 5 }, nodeId: null },
    ]);
  });

  it("keeps two citations for the same document cited twice with different pages", () => {
    expect(extractCitations("See report.pdf p.5 and later report.pdf p.9 as well.")).toEqual([
      { token: "report.pdf#p5", docName: "report.pdf", pages: { from: 5, to: 5 }, nodeId: null },
      { token: "report.pdf#p9", docName: "report.pdf", pages: { from: 9, to: 9 }, nodeId: null },
    ]);
  });
});

describe("extractCitations - document plus node, bound within a sentence", () => {
  it("binds a node to its document in the same sentence, document first", () => {
    expect(extractCitations("See report.pdf, node_id: 0003 for details.")).toEqual([
      { token: "report.pdf#n0003", docName: "report.pdf", pages: null, nodeId: "0003" },
    ]);
  });

  it("binds a node to its document in the same sentence, node first (either order)", () => {
    expect(extractCitations("See node_id: 0003 in report.pdf for details.")).toEqual([
      { token: "report.pdf#n0003", docName: "report.pdf", pages: null, nodeId: "0003" },
    ]);
  });

  it("matches node_id with = instead of :", () => {
    expect(extractCitations("See report.pdf, node_id=0003 for details.")).toEqual([
      { token: "report.pdf#n0003", docName: "report.pdf", pages: null, nodeId: "0003" },
    ]);
  });

  it("does NOT bind a node cited in the next sentence", () => {
    // Sentence boundary: a run of .!? followed by whitespace and a capital letter (or by
    // end of string), or a run of newlines. See src/grammar.ts for the full definition.
    expect(
      extractCitations("See report.pdf for details. Also check node_id: 0003 elsewhere."),
    ).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
      { token: "node_id:0003", docName: null, pages: null, nodeId: "0003" },
    ]);
  });

  it("does not treat the p. page abbreviation as a sentence boundary", () => {
    // "report.pdf p. 5" must stay one sentence so a later node_id in the same sentence
    // still binds - the digit after "p." is never mistaken for the start of a new
    // sentence (see the sentence-boundary heuristic in src/grammar.ts).
    expect(extractCitations("See report.pdf p. 5, node_id: 0003 for details.")).toEqual([
      {
        token: "report.pdf#p5&n0003",
        docName: "report.pdf",
        pages: { from: 5, to: 5 },
        nodeId: "0003",
      },
    ]);
  });
});

describe("extractCitations - document plus page plus node together", () => {
  // Judgment call: a page and a node cited for the SAME document in the SAME sentence
  // produce ONE citation carrying both fields, not two. Both fields describe the same
  // verification target (one document lookup), and the Citation shape allows both to be
  // set at once - splitting them into two citations would double-count a single agent
  // intent. The combined canonical token appends "&n<id>" after the page suffix so it
  // stays unambiguous and round-trippable by eye: "report.pdf#p5&n0003" is clearly
  // "report.pdf, page 5, node 0003" and not a coincidental collision with any other shape.
  it("combines a page and a node cited together for the same document into one citation", () => {
    expect(extractCitations("See report.pdf page 5, node_id: 0003 for details.")).toEqual([
      {
        token: "report.pdf#p5&n0003",
        docName: "report.pdf",
        pages: { from: 5, to: 5 },
        nodeId: "0003",
      },
    ]);
  });

  it("combines a page range and a node cited together for the same document", () => {
    expect(extractCitations("See report.pdf pp.5-7, node_id: 0003 for details.")).toEqual([
      {
        token: "report.pdf#p5-7&n0003",
        docName: "report.pdf",
        pages: { from: 5, to: 7 },
        nodeId: "0003",
      },
    ]);
  });
});

describe("extractCitations - bare node_id with no document", () => {
  it("reports docName: null for a bare node_id with no document anywhere in the text", () => {
    expect(extractCitations("See node_id: some-doc-id-123 for details.")).toEqual([
      { token: "node_id:some-doc-id-123", docName: null, pages: null, nodeId: "some-doc-id-123" },
    ]);
  });

  it("does not swallow a sentence-final period into a bare node id", () => {
    expect(extractCitations("The source is node_id: abc-123.")).toEqual([
      { token: "node_id:abc-123", docName: null, pages: null, nodeId: "abc-123" },
    ]);
  });

  it("does not swallow a trailing bracket into a bare node id", () => {
    expect(extractCitations("(node_id: abc-123)")).toEqual([
      { token: "node_id:abc-123", docName: null, pages: null, nodeId: "abc-123" },
    ]);
  });

  it("drops a bare node_id that is empty once trailing punctuation is stripped", () => {
    // An ellipsis placeholder must not become an empty nodeId, nor an empty token
    // inflating the citation count.
    expect(extractCitations("node_id: ...")).toEqual([]);
  });

  it("still finds a valid node_id after an unmatched one is dropped", () => {
    expect(extractCitations("node_id: ). node_id: abc-123")).toEqual([
      { token: "node_id:abc-123", docName: null, pages: null, nodeId: "abc-123" },
    ]);
  });
});

describe("extractCitations - dedup and ordering", () => {
  it("dedupes identical citations, keeping first-seen order", () => {
    const text = "node_id: aaa node_id: bbb node_id: aaa";
    expect(extractCitations(text)).toEqual([
      { token: "node_id:aaa", docName: null, pages: null, nodeId: "aaa" },
      { token: "node_id:bbb", docName: null, pages: null, nodeId: "bbb" },
    ]);
  });

  it("orders citations by first-seen text position across ALL patterns, not grouped by pattern", () => {
    // Naively concatenating "all node matches" then "all remaining doc matches" (the
    // processing order used internally) would put the bare node_id first, even though
    // it appears textually second. This pins the position-based sort.
    const text =
      "First see manual.pdf p.5. Then bare node_id: 0007 appears alone. Finally report.pdf is cited with no marker.";
    expect(extractCitations(text)).toEqual([
      { token: "manual.pdf#p5", docName: "manual.pdf", pages: { from: 5, to: 5 }, nodeId: null },
      { token: "node_id:0007", docName: null, pages: null, nodeId: "0007" },
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
    ]);
  });
});

describe("extractCitations - no citations", () => {
  it("returns an empty array for plain prose", () => {
    expect(extractCitations("This is plain prose with no citations at all.")).toEqual([]);
  });
});
