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

describe("extractCitations - sentence boundary must not under-detect (review fix: Critical 1)", () => {
  it("does not bind a node across a boundary whose next sentence starts with a lowercase word", () => {
    expect(extractCitations("See report.pdf for details. also check node_id: 0003.")).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
      { token: "node_id:0003", docName: null, pages: null, nodeId: "0003" },
    ]);
  });

  it("does not bind a node across a boundary whose next sentence starts with a digit", () => {
    expect(
      extractCitations("Costs are covered in budget.pdf. 2024 figures come from node_id: 0012."),
    ).toEqual([
      { token: "budget.pdf", docName: "budget.pdf", pages: null, nodeId: null },
      { token: "node_id:0012", docName: null, pages: null, nodeId: "0012" },
    ]);
  });

  it("treats an exclamation mark as a sentence boundary too", () => {
    expect(extractCitations("Read report.pdf! node_id: 0003 is next.")).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
      { token: "node_id:0003", docName: null, pages: null, nodeId: "0003" },
    ]);
  });
});

describe("extractCitations - node binds to the nearer edge of a document mention (review fix: Critical 2)", () => {
  it("prefers a long document name immediately before the node over a short one much further away", () => {
    expect(
      extractCitations("See verylongdocumentname.pdf, node_id: 0003, and b.pdf follows."),
    ).toEqual([
      {
        token: "verylongdocumentname.pdf#n0003",
        docName: "verylongdocumentname.pdf",
        pages: null,
        nodeId: "0003",
      },
      { token: "b.pdf", docName: "b.pdf", pages: null, nodeId: null },
    ]);
  });
});

describe("extractCitations - delimited document names containing spaces (review fix: Critical 3)", () => {
  it("takes a double-quoted name verbatim, spaces included", () => {
    expect(extractCitations('The source is "Annual Report.pdf".')).toEqual([
      { token: "Annual Report.pdf", docName: "Annual Report.pdf", pages: null, nodeId: null },
    ]);
  });

  it("binds a page marker following the closing delimiter of a double-quoted name", () => {
    expect(extractCitations('See "Annual Report 2024.pdf", p.3.')).toEqual([
      {
        token: "Annual Report 2024.pdf#p3",
        docName: "Annual Report 2024.pdf",
        pages: { from: 3, to: 3 },
        nodeId: null,
      },
    ]);
  });

  it("takes a backtick-quoted name verbatim", () => {
    expect(extractCitations("See `Annual Report.pdf` for details.")).toEqual([
      { token: "Annual Report.pdf", docName: "Annual Report.pdf", pages: null, nodeId: null },
    ]);
  });

  it("does not also emit a bare citation for the space-free tail inside a quoted name", () => {
    expect(extractCitations('The source is "Annual Report.pdf".')).toHaveLength(1);
  });

  it("still reads an unquoted multi-word name as its last space-free segment (documented limitation)", () => {
    // Bare prose gives no way to tell how far back a name extends; see the comment next to
    // DOC_NAME_PATTERN in src/grammar.ts. Callers who need spaces in a name must quote it -
    // this pins the current, deliberate behaviour so a future change notices it.
    expect(extractCitations("The source is Annual Report 2024.pdf, p.3.")).toEqual([
      { token: "2024.pdf#p3", docName: "2024.pdf", pages: { from: 3, to: 3 }, nodeId: null },
    ]);
  });
});

describe("extractCitations - page adjacency does not cross a newline (review fix: Important 4)", () => {
  it("does not bind a page marker on a later line to a document mentioned on an earlier line", () => {
    expect(extractCitations("See report.pdf,\n\n   pages 250-260 of the appendix.")).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
    ]);
  });
});

describe("extractCitations - the .pdf extension matches case-insensitively (review fix: Important 5)", () => {
  it("recognizes an uppercase extension and preserves it verbatim", () => {
    expect(extractCitations("The source is REPORT.PDF and nothing else.")).toEqual([
      { token: "REPORT.PDF", docName: "REPORT.PDF", pages: null, nodeId: null },
    ]);
  });

  it("recognizes an uppercase extension with a page", () => {
    expect(extractCitations("The source is Guide.PDF, p.4.")).toEqual([
      { token: "Guide.PDF#p4", docName: "Guide.PDF", pages: { from: 4, to: 4 }, nodeId: null },
    ]);
  });
});

describe("extractCitations - a node id's own text never synthesizes a document (review fix: Important 6)", () => {
  it("does not treat a .pdf-shaped substring inside a node id as a document", () => {
    expect(extractCitations("The pointer is node_id: sub/chapter.pdf here.")).toEqual([
      { token: "node_id:sub/chapter.pdf", docName: null, pages: null, nodeId: "sub/chapter.pdf" },
    ]);
  });
});

describe("extractCitations - review fix: Minor", () => {
  it("requires at least one real character in the document name", () => {
    expect(extractCitations("A stray ..pdf mention.")).toEqual([]);
  });

  it("accepts an en dash as a page range separator", () => {
    expect(extractCitations("See report.pdf pp.5–7 for details.")).toEqual([
      { token: "report.pdf#p5-7", docName: "report.pdf", pages: { from: 5, to: 7 }, nodeId: null },
    ]);
  });

  it("does not let an absurdly long page number drift the canonical token", () => {
    expect(extractCitations("See report.pdf p.99999999999999999999 for details.")).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
    ]);
  });
});

describe("extractCitations - a prose quote must not become the document name (re-review fix: Critical)", () => {
  it("no longer treats a single-quoted name as a delimiter (dropped per the ruling)", () => {
    // Apostrophes are constant in English prose; a single-quoted file name in agent output
    // is vanishingly rare. Falls back to the documented bare-name limitation: read as its
    // last space-free segment.
    expect(extractCitations("See 'Annual Report 2024.pdf' here.")).toEqual([
      { token: "2024.pdf", docName: "2024.pdf", pages: null, nodeId: null },
    ]);
  });

  it("rejects an ordinary quotation and lets the bare name inside it stand", () => {
    expect(extractCitations('He said "the data comes from report.pdf" yesterday.')).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
    ]);
  });

  it("does not treat a possessive apostrophe before .pdf as a delimiter", () => {
    expect(extractCitations("We don't have report.pdf's data.")).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
    ]);
  });

  it("does not treat a possessive apostrophe elsewhere in the sentence as a delimiter", () => {
    expect(extractCitations("Per the team's view of report.pdf's data.")).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
    ]);
  });

  it("accepts a two-word backtick-quoted span even when it reads like a shell command (accepted trade-off)", () => {
    // "cat report.pdf" is 2 words, under the 4-word cap, and file-name-shaped - genuinely
    // indistinguishable from a real two-word file name. Operator-accepted: the direction of
    // the resulting error is a single false `unresolved` for THIS citation, not a mass
    // deletion of every citation in the document (the failure mode this fix round exists to
    // close). Pinned here so a future change notices if this trade-off shifts.
    expect(
      extractCitations("Markdown code `cat report.pdf` then `open other.pdf` done."),
    ).toEqual([
      { token: "cat report.pdf", docName: "cat report.pdf", pages: null, nodeId: null },
      { token: "open other.pdf", docName: "open other.pdf", pages: null, nodeId: null },
    ]);
  });

  it("ignores mismatched delimiters and lets the bare name inside stand", () => {
    const text = 'The file is "report.pdf` for details.';
    expect(extractCitations(text)).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
    ]);
  });

  it("degrades gracefully on nested delimiters: the outer span is rejected, both inner bare names survive", () => {
    // The outer double-quote match is structurally valid (content ends in "beta.pdf" right
    // before the closing quote) but contains a backtick, which fails the file-name-shape
    // check - rejected, so it must not suppress EITHER bare name inside it.
    expect(extractCitations("See \"quoted `alpha.pdf` beta.pdf\" here.")).toEqual([
      { token: "alpha.pdf", docName: "alpha.pdf", pages: null, nodeId: null },
      { token: "beta.pdf", docName: "beta.pdf", pages: null, nodeId: null },
    ]);
  });

  it("does not let a rejected quote swallow the real document, its page, or its node in a realistic paragraph", () => {
    const text =
      'The vendor\'s contract is summarized in contract.pdf, p.12. The reviewer noted ' +
      '"the risk section is missing from contract.pdf" and asked for node_id: 0042. ' +
      "See also appendix.pdf.";
    expect(extractCitations(text)).toEqual([
      { token: "contract.pdf#p12", docName: "contract.pdf", pages: { from: 12, to: 12 }, nodeId: null },
      { token: "contract.pdf#n0042", docName: "contract.pdf", pages: null, nodeId: "0042" },
      { token: "appendix.pdf", docName: "appendix.pdf", pages: null, nodeId: null },
    ]);
  });
});

describe("extractCitations - re-review fix: Minor", () => {
  it("does not re-admit cross-sentence node binding when a sentence genuinely ends in 'p.'", () => {
    // "p." is only a page abbreviation - and only then exempt from being a sentence
    // boundary - when a page NUMBER actually follows it. Here it is followed by "Then", not
    // a digit, so it is a real sentence end and node_id: 0003 is in the NEXT sentence.
    expect(extractCitations("Read report.pdf, p. Then node_id: 0003.")).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
      { token: "node_id:0003", docName: null, pages: null, nodeId: "0003" },
    ]);
  });

  it("still treats p. before a page number as one sentence (regression check)", () => {
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
