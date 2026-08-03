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

describe("extractCitations - word-form page range 'to' (tool-description audit, addition 1)", () => {
  it("recognizes 'pages N to M' as a range, not a truncated single page", () => {
    expect(extractCitations("See report.pdf pages 5 to 7 for details.")).toEqual([
      { token: "report.pdf#p5-7", docName: "report.pdf", pages: { from: 5, to: 7 }, nodeId: null },
    ]);
  });

  it("recognizes 'pp.N to M' as a range too", () => {
    expect(extractCitations("See report.pdf pp.5 to 7 for details.")).toEqual([
      { token: "report.pdf#p5-7", docName: "report.pdf", pages: { from: 5, to: 7 }, nodeId: null },
    ]);
  });

  it("still accepts the existing hyphen and en-dash separators (regression)", () => {
    expect(extractCitations("See report.pdf pages 5-7 for details.")).toEqual([
      { token: "report.pdf#p5-7", docName: "report.pdf", pages: { from: 5, to: 7 }, nodeId: null },
    ]);
  });
});

describe("extractCitations - page markers not glued to the name (tool-description audit, addition 2)", () => {
  it("binds a page marker wrapped in parentheses", () => {
    expect(extractCitations("See report.pdf (page 5) for details.")).toEqual([
      { token: "report.pdf#p5", docName: "report.pdf", pages: { from: 5, to: 5 }, nodeId: null },
    ]);
  });

  it("binds a page marker wrapped in square brackets, with a keyword abbreviation", () => {
    expect(extractCitations("See report.pdf [p. 5] for details.")).toEqual([
      { token: "report.pdf#p5", docName: "report.pdf", pages: { from: 5, to: 5 }, nodeId: null },
    ]);
  });

  it("binds a page marker introduced by the connector word 'on'", () => {
    expect(extractCitations("See report.pdf on page 5 for details.")).toEqual([
      { token: "report.pdf#p5", docName: "report.pdf", pages: { from: 5, to: 5 }, nodeId: null },
    ]);
  });

  it("binds a page marker introduced by ', see' (comma plus connector word)", () => {
    expect(extractCitations("See report.pdf, see page 5 for details.")).toEqual([
      { token: "report.pdf#p5", docName: "report.pdf", pages: { from: 5, to: 5 }, nodeId: null },
    ]);
  });

  it("does not bind a bracketed page marker across a newline", () => {
    // The separator widening (parens/brackets, connector words) must stay confined to
    // horizontal whitespace, exactly like the original comma/semicolon separator - a page
    // marker starting a new line is still unrelated prose, not a narrower reference to the
    // document named above it.
    expect(extractCitations("See report.pdf\n(page 5) for details.")).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
    ]);
  });

  it("binds an 'on page N' marker to the nearer document, not one mentioned earlier in the sentence", () => {
    // The connector-word list is closed (on/at/see only) and requires the keyword to
    // follow immediately after mandatory whitespace, so it can never span an intervening
    // document mention the way an open-ended "any word" rule could.
    expect(extractCitations("See a.pdf and b.pdf on page 5")).toEqual([
      { token: "a.pdf", docName: "a.pdf", pages: null, nodeId: null },
      { token: "b.pdf#p5", docName: "b.pdf", pages: { from: 5, to: 5 }, nodeId: null },
    ]);
  });
});

describe("extractCitations - quoted-name page markers share the bare-name separator (spike/audit addition 1)", () => {
  it("binds a page marker wrapped in parentheses to a quoted name", () => {
    expect(extractCitations('See "Annual Report.pdf" (page 5) for details.')).toEqual([
      {
        token: "Annual Report.pdf#p5",
        docName: "Annual Report.pdf",
        pages: { from: 5, to: 5 },
        nodeId: null,
      },
    ]);
  });

  it("binds a page marker introduced by the connector word 'on' to a quoted name", () => {
    expect(extractCitations('See "Annual Report.pdf" on page 5.')).toEqual([
      {
        token: "Annual Report.pdf#p5",
        docName: "Annual Report.pdf",
        pages: { from: 5, to: 5 },
        nodeId: null,
      },
    ]);
  });

  it("binds a page marker introduced by ', see' to a quoted name", () => {
    expect(extractCitations('See "Annual Report.pdf", see page 5.')).toEqual([
      {
        token: "Annual Report.pdf#p5",
        docName: "Annual Report.pdf",
        pages: { from: 5, to: 5 },
        nodeId: null,
      },
    ]);
  });

  it("still binds the tight adjacent form to a quoted name (regression)", () => {
    expect(extractCitations('See "Annual Report.pdf", p.5 for details.')).toEqual([
      {
        token: "Annual Report.pdf#p5",
        docName: "Annual Report.pdf",
        pages: { from: 5, to: 5 },
        nodeId: null,
      },
    ]);
  });
});

describe("extractCitations - a dash range separator may carry surrounding horizontal whitespace (spike/audit addition 2)", () => {
  it("accepts a hyphen with spaces around it", () => {
    expect(extractCitations("See report.pdf pp. 5 - 7 for details.")).toEqual([
      { token: "report.pdf#p5-7", docName: "report.pdf", pages: { from: 5, to: 7 }, nodeId: null },
    ]);
  });

  it("accepts an en dash with spaces around it", () => {
    expect(extractCitations("See report.pdf pp. 5 – 7 for details.")).toEqual([
      { token: "report.pdf#p5-7", docName: "report.pdf", pages: { from: 5, to: 7 }, nodeId: null },
    ]);
  });

  it("still accepts the tight hyphen form with no spaces (regression)", () => {
    expect(extractCitations("See report.pdf pp.5-7 for details.")).toEqual([
      { token: "report.pdf#p5-7", docName: "report.pdf", pages: { from: 5, to: 7 }, nodeId: null },
    ]);
  });

  it("still accepts the tight en-dash form with no spaces (regression)", () => {
    expect(extractCitations("See report.pdf pp.5–7 for details.")).toEqual([
      { token: "report.pdf#p5-7", docName: "report.pdf", pages: { from: 5, to: 7 }, nodeId: null },
    ]);
  });
});

describe("extractCitations - generic bracket-tag citation (spike A addition 3)", () => {
  it("recognizes a [node:<id>] bracket tag and routes it to unchecked (docName: null)", () => {
    expect(extractCitations("See [node:some-doc-id-123] for details.")).toEqual([
      { token: "node_id:some-doc-id-123", docName: null, pages: null, nodeId: "some-doc-id-123" },
    ]);
  });

  it("keeps the keyword generic - a [<word>:<id>] shape is recognized, not only 'node'", () => {
    expect(extractCitations("See [chunk:abc-42] for details.")).toEqual([
      { token: "node_id:abc-42", docName: null, pages: null, nodeId: "abc-42" },
    ]);
  });

  it("does not recognize a URL-valued tag - a different citation family this tool must not resolve", () => {
    expect(extractCitations("See [Source: https://example.com/doc] for details.")).toEqual([]);
  });

  it("trims whitespace inside the brackets", () => {
    expect(extractCitations("See [node: some-doc-id-123 ] for details.")).toEqual([
      { token: "node_id:some-doc-id-123", docName: null, pages: null, nodeId: "some-doc-id-123" },
    ]);
  });

  it("drops an empty bracket tag", () => {
    expect(extractCitations("See [node:] for details.")).toEqual([]);
  });

  it("extracts the real document from inside a bracket-tag value instead of swallowing it (whole-branch review fix, defect 2)", () => {
    // Previously this test pinned the opposite behavior (swallow the whole value, report
    // unchecked), framed only as "must not synthesize a document out of nothing". The
    // whole-branch review found the missed case: when the bracketed value IS a real
    // citation, swallowing it does not protect anything - it hides a checkable document
    // behind docName: null, and CLAUDE.md hard rule 4 tells a consuming agent to KEEP
    // every `unchecked` citation. A fabricated document inside a bracket tag must be
    // checked and reported `unresolved`, not preserved by policy. Corrected: the
    // bracket-tag machinery steps aside when the value is document-shaped and lets the
    // ordinary document scan read the real citation out of it.
    //
    // Final-review amendment: the input needs the space that a tag in real output carries.
    // The step-aside is now decided by the ONE question "would the bare pass accept a
    // document starting in these characters", so that the two paths cannot disagree; with no
    // space after the keyword's colon the name's left neighbour is that colon, which is an
    // identifier continuation ("ns:chapter.pdf"), so neither path checks it. That case is
    // pinned separately, in the Minor 7 block - it reports `unchecked`, which keeps the
    // citation, so the direction is the safe one.
    expect(extractCitations("See [node: report.pdf] for details.")).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
    ]);
  });

  it("does NOT bind to a document named in the same sentence - always docName: null", () => {
    // Deliberate divergence from node_id:, which DOES bind. Reasoning: node_id: is this
    // grammar's own name for the backend's real per-document node ordinal
    // (docs/spike-b-findings.md), so binding it to a document lets the resolver check it
    // against that document's real node set. A bracket-tag id (docs/spike-a-findings.md)
    // is a host-invented slug from a completely different, unconfirmed id space with no
    // guaranteed relationship to the backend's node_id ordinals - binding it would let the
    // resolver run a real per-document node check against an id that was never drawn from
    // that space, risking exactly the dangerous false `unresolved` direction (CLAUDE.md
    // hard rule 4) instead of the always-safe `unchecked` the spike itself recommends.
    expect(extractCitations("See report.pdf and [node:some-doc-id-123] together.")).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
      { token: "node_id:some-doc-id-123", docName: null, pages: null, nodeId: "some-doc-id-123" },
    ]);
  });

  it("dedupes with an equivalent node_id: citation sharing the same canonical token", () => {
    // Canonical-token decision: a bracket tag renders to the SAME "node_id:<id>" prefix an
    // unbound node_id: citation already uses, not a new "bracket:<id>" shape of its own -
    // both reduce to the identical Citation fields (docName: null, nodeId: id), and a
    // consuming agent should not see two different-looking citations for what is, after
    // verification, the same unverifiable claim.
    expect(extractCitations("See node_id: 0003 and [node:0003] together.")).toEqual([
      { token: "node_id:0003", docName: null, pages: null, nodeId: "0003" },
    ]);
  });
});

describe("extractCitations - a bracket-tag value containing a real citation is extracted, not swallowed (whole-branch review fix, defect 2)", () => {
  it("extracts a fabricated-looking but real-shaped document name from inside a bracket tag", () => {
    // The document name itself may or may not exist in the corpus - that is the
    // resolver's job to check (`unresolved` if not found). The grammar's job is only to
    // make sure it is SEEN, so a fabrication cannot hide behind `unchecked`.
    expect(extractCitations("[cite: fabricated-report.pdf]")).toEqual([
      { token: "fabricated-report.pdf", docName: "fabricated-report.pdf", pages: null, nodeId: null },
    ]);
  });

  it("extracts a document plus its page from inside a bracket tag", () => {
    expect(extractCitations("[Source: report.pdf p.12]")).toEqual([
      { token: "report.pdf#p12", docName: "report.pdf", pages: { from: 12, to: 12 }, nodeId: null },
    ]);
  });

  it("extracts a document and binds a node cited together inside the same bracket tag", () => {
    expect(extractCitations("[note: see report.pdf, node_id: 0003]")).toEqual([
      { token: "report.pdf#n0003", docName: "report.pdf", pages: null, nodeId: "0003" },
    ]);
  });

  it("still reserves and reports unchecked for a value that is NOT document-shaped (regression)", () => {
    expect(extractCitations("[node: some-doc-id-123]")).toEqual([
      { token: "node_id:some-doc-id-123", docName: null, pages: null, nodeId: "some-doc-id-123" },
    ]);
  });

  it("still excludes a URL-valued tag entirely - defect 1's fix must not fight defect 2's (regression)", () => {
    expect(extractCitations("[Source: https://example.com/doc.pdf]")).toEqual([]);
  });
});

describe("extractCitations - a bare match that is part of a URL is not read as a document (whole-branch review fix, defect 1)", () => {
  it("does not read a bare https URL ending in .pdf as a document", () => {
    expect(extractCitations("Source: https://example.com/whitepaper.pdf for the numbers.")).toEqual([]);
  });

  it("does not read a bare http URL with a page marker as a document", () => {
    expect(extractCitations("See http://example.org/files/annual-report.pdf p.12.")).toEqual([]);
  });

  it("still extracts a real document name when an unrelated URL appears elsewhere in the text", () => {
    expect(
      extractCitations(
        "See https://example.com/context.pdf for background, but the real numbers are in report.pdf.",
      ),
    ).toEqual([{ token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null }]);
  });

  it("does not need the '://' signal to leave a scheme-relative URL's path alone", () => {
    // The URL guard still recognizes only "://", matching the bracket-tag path's own rule
    // exactly: bare "//" is a much weaker signal and is deliberately not guessed at. These
    // two inputs USED to be extracted for that reason, and the final review's run-END guard
    // makes the question moot from the other side - a name preceded by "/" is the last
    // segment of a path, not a standalone token, and a real document name cannot contain a
    // "/" at all. The guard the bracket-tag path already applied to "sub/chapter.pdf" now
    // applies here too, so the two agree for a second reason rather than by coincidence.
    expect(extractCitations("See //example.com/report.pdf for details.")).toEqual([]);
  });

  it("leaves a bare host's path alone as well, for the same reason", () => {
    expect(extractCitations("See example.com/report.pdf for details.")).toEqual([]);
  });

  it("still extracts a name that merely follows a host name, with a boundary between them", () => {
    // Containment: the "/" rule above must not spread to text that only mentions a domain.
    expect(extractCitations("On example.com, see report.pdf for details.")).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
    ]);
  });
});

describe("extractCitations - a non-ASCII document name is extracted whole, never as a fragment (re-review fix: Critical 1)", () => {
  // The name character class used to be ASCII-only, so the run was cut at the FIRST
  // non-ASCII letter and the surviving fragment was emitted as though it were the document
  // name: "rapport-général-2024.pdf" was checked as "ral-2024.pdf". The corpus cannot
  // contain the fragment, so a correctly cited, existing document came back `unresolved`
  // and a consuming agent deleted it (CLAUDE.md hard rule 4). Two things are pinned here:
  // a truncated fragment is never emitted, and a real non-ASCII name is extracted whole.
  it("extracts a name containing diacritics whole instead of truncating it at the first one", () => {
    expect(extractCitations("Revenue is stated in rapport-général-2024.pdf for the year.")).toEqual([
      {
        token: "rapport-général-2024.pdf",
        docName: "rapport-général-2024.pdf",
        pages: null,
        nodeId: null,
      },
    ]);
  });

  it("keeps two distinct names distinct instead of collapsing them into one shared fragment", () => {
    // Dedup is by canonical token, so two names truncated to the same fragment used to
    // collapse into ONE citation - the second document was reported in no status at all.
    expect(extractCitations("See rapport-général.pdf and plan-général.pdf together.")).toEqual([
      { token: "rapport-général.pdf", docName: "rapport-général.pdf", pages: null, nodeId: null },
      { token: "plan-général.pdf", docName: "plan-général.pdf", pages: null, nodeId: null },
    ]);
  });

  it("extracts a name whose very first character is non-ASCII", () => {
    expect(extractCitations("The source is Überblick.pdf and nothing else.")).toEqual([
      { token: "Überblick.pdf", docName: "Überblick.pdf", pages: null, nodeId: null },
    ]);
  });

  it("extracts a name written in a non-Latin script whole", () => {
    expect(extractCitations("The source is отчёт-2024.pdf and nothing else.")).toEqual([
      { token: "отчёт-2024.pdf", docName: "отчёт-2024.pdf", pages: null, nodeId: null },
    ]);
  });

  it("binds a page marker to a non-ASCII name", () => {
    expect(extractCitations("See rapport-général.pdf p.5 for details.")).toEqual([
      {
        token: "rapport-général.pdf#p5",
        docName: "rapport-général.pdf",
        pages: { from: 5, to: 5 },
        nodeId: null,
      },
    ]);
  });

  it("takes a quoted non-ASCII name containing spaces verbatim", () => {
    expect(extractCitations('The source is "Rapport Général 2024.pdf".')).toEqual([
      {
        token: "Rapport Général 2024.pdf",
        docName: "Rapport Général 2024.pdf",
        pages: null,
        nodeId: null,
      },
    ]);
  });

  it("still requires a real name character before the extension in non-ASCII prose", () => {
    // Containment check: widening the character class must not let ordinary prose that
    // merely mentions the extension become a document name.
    expect(extractCitations("Le document a été enregistré au format .pdf hier.")).toEqual([]);
  });
});

describe("extractCitations - containment: a bare name in a script with no word spaces is not extracted (re-review fix: Critical 1)", () => {
  // Widening the name class to Unicode letters is what stops a diacritic from truncating a
  // name, but in a script that does not separate words with spaces there is no boundary for
  // the greedy run to stop at, so it would swallow the whole clause and report THAT as the
  // document name - "我们在这个文件里看到报告.pdf" - a token the author never wrote,
  // reported `unresolved`, which is precisely the deletion CLAUDE.md hard rule 4 exists to
  // prevent. Characters from those scripts therefore end the run, which leaves their
  // behaviour exactly as it was before the widening: a bare name is not extracted at all
  // (silence, the safe direction), and quoting is the supported, exact route.
  it("does not read a bare no-space-script name as a document, rather than swallowing the clause", () => {
    expect(extractCitations("詳細は年次報告書.pdf をご覧ください。")).toEqual([]);
  });

  it("extracts the same no-space-script name when it is quoted", () => {
    expect(extractCitations('詳細は "年次報告書.pdf" をご覧ください。')).toEqual([
      { token: "年次報告書.pdf", docName: "年次報告書.pdf", pages: null, nodeId: null },
    ]);
  });

  it("does not extract a Latin-script name glued directly to no-space-script text either", () => {
    // Final-review fix (Critical 1). This case USED to be extracted, and that permission is
    // exactly what truncated a real mixed-script name to a fragment: the grammar cannot tell
    // "詳細はreport.pdf" (a whole Latin name after a particle) from "報告書2024.pdf" (the tail
    // of a single mixed name), because the two are the identical shape - a run of name
    // characters starting immediately after a no-space-script character. One of the two has
    // to give, and emitting "2024.pdf" for the second is the deletion direction, so the
    // permission is withdrawn for both. The cost is under-reach: the name here goes
    // unverified. Silence is the safe direction (CLAUDE.md hard rule 4), and quoting remains
    // the exact route.
    expect(extractCitations("詳細はreport.pdf をご覧ください。")).toEqual([]);
  });
});

describe("extractCitations - a name mixing a no-space script with Latin or digits is never truncated to a fragment (final review: Critical 1)", () => {
  // The containment above (no-space-script characters END a name run) did NOT produce the
  // silence it claimed for the common real shape of a CJK file name: a name that MIXES such
  // a script with Latin letters or digits was cut at the script boundary and the surviving
  // FRAGMENT was checked as though it were the document. With the real document present in
  // the corpus, "会议纪要_v2.pdf" was looked up as "_v2.pdf", came back `unresolved`, and a
  // consuming agent deleted a correctly cited, genuinely present source - the precise
  // failure CLAUDE.md hard rule 4 exists to prevent.
  it("does not emit a fragment of a Han name carrying an ASCII suffix", () => {
    expect(extractCitations("The figures come from 会议纪要_v2.pdf.")).toEqual([]);
  });

  it("does not emit a fragment of a Han name carrying digits", () => {
    expect(extractCitations("See 報告書2024.pdf for the breakdown.")).toEqual([]);
  });

  it("does not emit a fragment of a Han name carrying a hyphenated Latin word", () => {
    expect(extractCitations("報告書-annual.pdf")).toEqual([]);
  });

  it("does not emit a fragment of a Kana name carrying digits", () => {
    expect(extractCitations("レポート2024.pdf")).toEqual([]);
  });

  it("does not emit a fragment of a Thai name carrying digits", () => {
    expect(extractCitations("รายงาน2024.pdf")).toEqual([]);
  });

  it("extracts the whole mixed-script name when it is quoted", () => {
    // Containment for the silence above: quoting is the supported, exact route, and it must
    // still deliver the name verbatim - otherwise the fix trades a fragment for a tool that
    // cannot check these names at all.
    expect(extractCitations('The figures come from "会议纪要_v2.pdf".')).toEqual([
      { token: "会议纪要_v2.pdf", docName: "会议纪要_v2.pdf", pages: null, nodeId: null },
    ]);
  });
});

describe("extractCitations - a name glued to other text by a character outside the name class is not read as a document (final review: Critical 1, related class)", () => {
  // Same class, same direction: any character that is neither a name character nor a
  // recognized prose boundary used to cut the run and let the TAIL be emitted as a document.
  // A fragment must never be emitted, whatever cut it out.
  it("does not emit the tail of a name joined by a plus", () => {
    expect(extractCitations("report+final.pdf")).toEqual([]);
  });

  it("does not emit the tail of a name joined by an at sign", () => {
    expect(extractCitations("report@2024.pdf")).toEqual([]);
  });

  it("does not emit the tail of a name joined by a zero-width non-joiner", () => {
    expect(extractCitations("report‌nonjoin.pdf")).toEqual([]);
  });
});

describe("extractCitations - a bracket-tag id containing a .pdf-shaped substring stays unchecked (re-review fix: Critical 2)", () => {
  // The bracket-tag path steps aside only when the value names a document as a WHOLE token.
  // An id that merely CONTAINS a .pdf-shaped substring is a host-invented slug from a
  // different id space, unverifiable by construction, and must be `unchecked` - exactly as
  // the identical id written as "node_id: ..." already is. Reporting the substring
  // `unresolved` makes a consuming agent delete a citation that was never checkable.
  it("does not read a path-shaped bracket-tag id as a document", () => {
    expect(extractCitations("[node: sub/chapter.pdf] confirms the figure.")).toEqual([
      { token: "node_id:sub/chapter.pdf", docName: null, pages: null, nodeId: "sub/chapter.pdf" },
    ]);
  });

  it("agrees with the node_id: path on the identical id", () => {
    // The two syntaxes name the same id space; they must not disagree about the same id.
    expect(extractCitations("[node: sub/chapter.pdf] confirms the figure.")).toEqual(
      extractCitations("The pointer is node_id: sub/chapter.pdf here."),
    );
  });

  it("does not read a .pdf-shaped prefix of a longer slug as a document", () => {
    expect(extractCitations("[node: v1.pdf-part2] confirms the figure.")).toEqual([
      { token: "node_id:v1.pdf-part2", docName: null, pages: null, nodeId: "v1.pdf-part2" },
    ]);
  });

  it("does not read a .pdf-shaped substring with trailing characters as a document", () => {
    expect(extractCitations("[node: report.pdfx]")).toEqual([
      { token: "node_id:report.pdfx", docName: null, pages: null, nodeId: "report.pdfx" },
    ]);
  });

  it("does not read a .pdf-shaped substring inside a dotted slug as a document", () => {
    expect(extractCitations("[node: 2024.pdf.chunk3]")).toEqual([
      { token: "node_id:2024.pdf.chunk3", docName: null, pages: null, nodeId: "2024.pdf.chunk3" },
    ]);
  });

  it("does not read a .pdf-shaped substring with an uppercase extension as a document", () => {
    expect(extractCitations("[node: a.PDF-thing]")).toEqual([
      { token: "node_id:a.PDF-thing", docName: null, pages: null, nodeId: "a.PDF-thing" },
    ]);
  });

  it("still steps aside for a value that names a document as a whole token (regression)", () => {
    expect(extractCitations("[Source: report.pdf p.12]")).toEqual([
      { token: "report.pdf#p12", docName: "report.pdf", pages: { from: 12, to: 12 }, nodeId: null },
    ]);
  });

  it("still steps aside for a QUOTED name inside the tag - the boundary is an identifier, not whitespace", () => {
    // Found while hunting for a victim of the boundary rule above: a first attempt that
    // required whitespace on both sides made this `unchecked`. Quoting is exactly what this
    // grammar tells a caller to do for a name containing a space, so a quoted name inside a
    // bracket tag has to reach the ordinary passes and be checked.
    expect(extractCitations('[cite: "Annual Report.pdf"]')).toEqual([
      { token: "Annual Report.pdf", docName: "Annual Report.pdf", pages: null, nodeId: null },
    ]);
  });

  it("treats a trailing period as sentence punctuation, not as an identifier continuation", () => {
    expect(extractCitations("[cite: report.pdf.]")).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
    ]);
  });

  it("accepted limitation: a value carrying BOTH a slug and a document reports only the document", () => {
    // The step-aside reserves nothing, so the slug is not reported in any status. Pinned
    // rather than fixed: the slug is unverifiable either way, and the document inside the
    // tag is a whole token that must be checked rather than hidden behind `unchecked`.
    expect(extractCitations("[node: abc-123 report.pdf]")).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
    ]);
  });
});

describe("extractCitations - a citation glued to a preceding URL by a non-URL character (re-review fix: Important 3)", () => {
  // The backward scan used to break on four ASCII whitespace characters only, so ANY other
  // character gluing a real citation to a preceding URL put that citation inside the URL's
  // run and dropped it in every status - absent from `details` entirely, which reads to a
  // consuming agent as "nothing here needed checking". The run now ends at the first
  // character no URL may contain, which covers the typographic characters that actually
  // occur in generated prose.
  it("extracts a document name separated from a URL by a non-breaking space", () => {
    expect(
      extractCitations("Mirror: https://example.com/x.html\u00A0report.pdf is the local copy."),
    ).toEqual([{ token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null }]);
  });

  it("extracts a document name separated from a URL by an em dash, and still suppresses the URL's own tail", () => {
    expect(
      extractCitations("Mirror: https://example.com/doc.pdf—report.pdf is the local copy."),
    ).toEqual([{ token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null }]);
  });

  it("extracts a document name separated from a URL by a typographic quote", () => {
    expect(
      extractCitations("Mirror: https://example.com/x.html”report.pdf is the local copy."),
    ).toEqual([{ token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null }]);
  });

  it("disclosed limitation: a character a URL path MAY contain does not end the run", () => {
    // ";" "," "(" ")" are all legal URL characters. Breaking the run on them would
    // un-suppress the final path segment of any real URL that contains one earlier in its
    // path (see the next test), turning a safe silence into a false `unresolved` that makes
    // a consuming agent delete a valid reference. Silence is the safe direction here
    // (CLAUDE.md hard rule 4), so this input stays dropped and is disclosed instead.
    expect(
      extractCitations("Mirror: https://example.com/doc.pdf;report.pdf is the local copy."),
    ).toEqual([]);
  });

  it("keeps suppressing the final segment of a URL whose path contains a comma", () => {
    expect(extractCitations("See https://example.com/w_100,h_200/report.pdf for details.")).toEqual(
      [],
    );
  });
});

describe("extractCitations - extraction cost stays bounded on adversarial input (re-review follow-up)", () => {
  // The text handed to this tool is UNTRUSTED: it is generated by a model, and a consuming
  // host passes it straight through. A quadratic scan is therefore a denial of service
  // handed to whoever writes the draft, not a benchmark curiosity - a stdio MCP server
  // burning tens of seconds of CPU inside a host request is an outage, and an outage must
  // never be mistaken for a verdict (CLAUDE.md hard rule 4). The document-name scan used to
  // re-scan an unbroken run of name characters once per starting position inside it; it now
  // only ever starts a match where the run itself starts, which makes the whole pass linear.
  //
  // The budget is wall-clock and deliberately loose: the measured cost of these inputs is a
  // few milliseconds and 38k characters of ordinary prose carrying 400 citations costs
  // under 10ms, so a 500ms ceiling leaves ~25x headroom for a loaded CI machine while still
  // catching a return of the quadratic (which cost 22s and 1s respectively on these inputs).
  const BUDGET_MS = 500;

  function msToExtract(text: string, expected: number): number {
    const started = performance.now();
    const citations = extractCitations(text);
    const elapsed = performance.now() - started;
    expect(citations).toHaveLength(expected);
    return elapsed;
  }

  it(
    "scans a long unbroken run of non-ASCII name characters in bounded time",
    () => {
      // 20k characters, one unbroken run of allowed name characters, no citation anywhere
      // in it - the worst case for a scan that restarts inside the run.
      expect(msToExtract("ą.".repeat(10_000) + "x", 0)).toBeLessThan(BUDGET_MS);
    },
    60_000,
  );

  it(
    "scans a long unbroken ASCII run in bounded time",
    () => {
      expect(msToExtract("a".repeat(20_000) + "!", 0)).toBeLessThan(BUDGET_MS);
    },
    60_000,
  );

  it(
    "scans a long bracket-tag value in bounded time",
    () => {
      // The bracket-tag path runs the same document scan over the tag's value.
      expect(msToExtract(`[node: ${"a".repeat(20_000)}]`, 1)).toBeLessThan(BUDGET_MS);
    },
    60_000,
  );

  it(
    "scans a text made up of thousands of quoted names in bounded time",
    () => {
      // A second, independent quadratic: the reserved-span bookkeeping used to be scanned
      // linearly per match, so cost grew with the NUMBER of citations rather than the length
      // of the text. 20k quoted names in a 160k-character draft; they all dedupe to one
      // citation, which is exactly why the cost was invisible in the output.
      expect(msToExtract('"a.pdf" '.repeat(20_000), 1)).toBeLessThan(BUDGET_MS);
    },
    60_000,
  );

  // The two assertions below are RATIO assertions as well as absolute ones. A wall-clock
  // threshold on a shared CI box or a loaded laptop is a flake generator, and its failure
  // reads as "the grammar regressed" when it means "the machine was busy"; the ratio between
  // two input sizes is machine-independent. Quadratic cost grows 16x per 4x of input and
  // cubic grows ~64x, so a ceiling of 8x (plus a floor that absorbs timer noise on inputs
  // that now cost single-digit milliseconds) separates them from linear without depending on
  // how fast the machine is.
  const SCALING_CEILING = 8;
  const SCALING_FLOOR_MS = 50;

  function expectSubQuadraticScaling(build: (k: number) => string, k: number, citations: (k: number) => number) {
    const small = msToExtract(build(k), citations(k));
    const large = msToExtract(build(k * 4), citations(k * 4));
    expect(large).toBeLessThan(SCALING_CEILING * small + SCALING_FLOOR_MS);
    return large;
  }

  it(
    "scans citations glued together by URL-legal characters in bounded time",
    () => {
      // A third quadratic: the URL guard re-scanned the whole preceding run of URL
      // characters once per match. "," continues a URL run, so a comma-separated source list
      // with no whitespace - an entirely ordinary shape - made every match re-scan the whole
      // draft. Measured before the fix: 8206 ms on the 16k form, growing 4x per doubling.
      // None of the four tests above reaches it, because whitespace or a quote ends the run
      // in all of them. All the names dedupe to one citation.
      const build = (k: number) => "y" + ",a.pdf".repeat(k);
      expect(expectSubQuadraticScaling(build, 4_000, () => 1)).toBeLessThan(BUDGET_MS);
    },
    60_000,
  );

  it(
    "binds nodes to documents across a draft full of both in bounded time",
    () => {
      // A fourth, and the worst: the node-binding loop was nodes x documents x
      // sentence-boundaries, i.e. cubic, on the most ordinary draft shape there is - every
      // sentence citing one document and one node. Measured before the fix: 11592 ms for a
      // 100 KB draft carrying 3200 citations, growing ~8x per doubling. None of the four
      // tests above builds both node mentions and document mentions.
      const build = (k: number) =>
        Array.from({ length: k }, (_, i) => `See doc${i}.pdf, node_id: ${i}. `).join("");
      expect(expectSubQuadraticScaling(build, 800, (k) => k)).toBeLessThan(BUDGET_MS);
    },
    60_000,
  );
});

describe("extractCitations - the URL exclusion covers the quoted pass too (re-review fix: Minor 4)", () => {
  it("does not extract a backtick-delimited file name that is part of a URL", () => {
    expect(extractCitations("See https://example.com/`report.pdf`")).toEqual([]);
  });

  it("does not extract a double-quoted file name that is part of a URL", () => {
    expect(extractCitations('See https://example.com/"report.pdf"')).toEqual([]);
  });

  it("still extracts a quoted name when an unrelated URL appears elsewhere in the text", () => {
    expect(
      extractCitations('See https://example.com/context.pdf and then "Annual Report.pdf" here.'),
    ).toEqual([
      { token: "Annual Report.pdf", docName: "Annual Report.pdf", pages: null, nodeId: null },
    ]);
  });
});

describe("extractCitations - a name glued into a longer token in ordinary prose is not a citation (final review: defect D1)", () => {
  // The bare pattern had a run-START guard and no run-END guard, so a name glued into a
  // longer token leaked a FABRICATED citation out of ordinary prose: "report.pdfx" yielded
  // "report.pdf", reported `unresolved`, and a consuming agent deletes what comes back
  // `unresolved`. The bracket-tag path already applied the OPPOSITE rule to these exact
  // strings (they stay `unchecked` there), and the comment above containsStandaloneDocName
  // argues that two syntaxes disagreeing about the same string is what CLAUDE.md hard rule 4
  // forbids. Prose is the third syntax and it disagreed with both.
  it("does not read a name with a trailing letter as a document", () => {
    expect(extractCitations("See report.pdfx for details.")).toEqual([]);
  });

  it("does not read a name with a trailing digit as a document", () => {
    expect(extractCitations("The file report.pdf2 is stale.")).toEqual([]);
  });

  it("does not read a .pdf-shaped substring inside a dotted token as a document", () => {
    expect(extractCitations("Chunk id 2024.pdf.chunk3 was used.")).toEqual([]);
  });

  it("does not read a .pdf-shaped prefix of a hyphenated token as a document", () => {
    expect(extractCitations("Look at v1.pdf-part2 please")).toEqual([]);
  });

  it("does not read the final segment of a path as a document", () => {
    expect(extractCitations("Path is sub/chapter.pdf here.")).toEqual([]);
  });

  it("does not read a name glued to a page keyword as a document", () => {
    expect(extractCitations("report.pdfpage 5 is odd")).toEqual([]);
  });

  it("agrees with the bracket-tag path on every one of those strings", () => {
    // The two syntaxes name the same character sequence; neither may report it as a
    // checkable document. The bracket form carries an id claim, so it reports `unchecked`;
    // prose carries no id claim, so it reports nothing. What must match is the one thing
    // that decides deletion: no docName anywhere.
    for (const id of ["report.pdfx", "report.pdf2", "2024.pdf.chunk3", "v1.pdf-part2", "sub/chapter.pdf"]) {
      expect(extractCitations(`See ${id} here.`).map((c) => c.docName)).toEqual([]);
      expect(extractCitations(`[node: ${id}] here.`)).toEqual([
        { token: `node_id:${id}`, docName: null, pages: null, nodeId: id },
      ]);
    }
  });
});

describe("extractCitations - containment for the boundary rule: ordinary prose punctuation still delimits a name", () => {
  // Hunting the victim of the run-END guard above. A boundary rule tightened one notch too
  // far swallows real citations, which is the mirror failure: a tool that extracts nothing
  // verifies nothing. Every shape here is ordinary agent output and must still be checked.
  const oneDoc = [{ token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null }];

  it("extracts a name that is the whole text", () => {
    expect(extractCitations("report.pdf")).toEqual(oneDoc);
  });

  it("extracts a name in parentheses", () => {
    expect(extractCitations("The source (report.pdf) is current.")).toEqual(oneDoc);
  });

  it("extracts a name followed by a possessive apostrophe", () => {
    expect(extractCitations("report.pdf's figures are current.")).toEqual(oneDoc);
  });

  it("extracts a name followed by an exclamation mark", () => {
    expect(extractCitations("The file is report.pdf!")).toEqual(oneDoc);
  });

  it("extracts a name wrapped in markdown emphasis", () => {
    expect(extractCitations("See **report.pdf** for details.")).toEqual(oneDoc);
  });

  it("extracts the link text of a markdown link", () => {
    expect(extractCitations("See [report.pdf](https://example.com/x) for details.")).toEqual(oneDoc);
  });

  it("extracts every name in a comma-separated source list", () => {
    expect(extractCitations("Sources: a.pdf,b.pdf,c.pdf")).toEqual([
      { token: "a.pdf", docName: "a.pdf", pages: null, nodeId: null },
      { token: "b.pdf", docName: "b.pdf", pages: null, nodeId: null },
      { token: "c.pdf", docName: "c.pdf", pages: null, nodeId: null },
    ]);
  });

  it("extracts a name followed by a typographic dash", () => {
    expect(extractCitations("report.pdf—the only source—is current.")).toEqual(oneDoc);
  });

  it("still binds a page marker to a name followed by an opening bracket", () => {
    expect(extractCitations("report.pdf (page 5) is the source.")).toEqual([
      { token: "report.pdf#p5", docName: "report.pdf", pages: { from: 5, to: 5 }, nodeId: null },
    ]);
  });

  it("extracts a name followed by a colon introducing a clause", () => {
    // A trailing ":" is punctuation when a boundary follows it, and a continuation otherwise
    // ("ns:chapter.pdf"). Without that asymmetry this ordinary shape went silent.
    expect(extractCitations("report.pdf: the figures are current.")).toEqual(oneDoc);
  });

  it("does not read the tail of a namespaced id as a document", () => {
    // The other half of the same asymmetry, kept here so the two are read together.
    expect(extractCitations("The pointer is ns:report.pdf here.")).toEqual([]);
  });
});

describe("extractCitations - an identifier's tail never escapes as a document, whatever separates it (final review: Important 3)", () => {
  // The identifier-continuation class used to be a closed list of characters, so a slug
  // separated by any OTHER character left its ".pdf" tail looking standalone: the bracket tag
  // stepped aside and the bare pass checked the fragment. Worse on the node_id: path, whose
  // own id charset ended at the same characters: "node_id: ns:chapter.pdf" reported
  // "chapter.pdf#nns" - a fabricated document name AND a fabricated node id in one token,
  // `unresolved`, i.e. deleted.
  const glued = [
    "doc%20name.pdf",
    "ns:chapter.pdf",
    "abc+report.pdf",
    "a@b.pdf",
    "id#3.pdf",
    "sub/chapter.pdf",
  ];

  it("reports a glued id as one unchecked node, never as a document", () => {
    for (const id of glued) {
      expect(extractCitations(`[node: ${id}] confirms the figure.`)).toEqual([
        { token: `node_id:${id}`, docName: null, pages: null, nodeId: id },
      ]);
    }
  });

  it("makes the node_id: path agree with the bracket-tag path on every one of them", () => {
    for (const id of glued) {
      expect(extractCitations(`The pointer is node_id: ${id} here.`)).toEqual(
        extractCitations(`[node: ${id}] here.`),
      );
    }
  });

  it("keeps the whole id in the reported token rather than a prefix of it", () => {
    expect(extractCitations("node_id=abc+report.pdf")).toEqual([
      {
        token: "node_id:abc+report.pdf",
        docName: null,
        pages: null,
        nodeId: "abc+report.pdf",
      },
    ]);
  });
});

describe("extractCitations - the node_id: and bracket-tag paths agree when the id IS a document name (final review: Minor 7)", () => {
  // The bracket path steps aside for a standalone document name precisely so a fabricated
  // "[cite: invented-report.pdf]" cannot hide behind `unchecked`. The node_id: path did not,
  // so "node_id: invented-report.pdf" still hid - and a comment claimed the two paths agree,
  // with no test defending it.
  //
  // What the two paths guarantee, now pinned rather than asserted: they agree on whether the
  // id names a checkable document, which is the only part of the answer that can lead to a
  // deletion. They are NOT byte-identical, and the last test here pins the one place they
  // differ: a bracket value is terminated by "]", so a trailing "." or ":" inside it is part
  // of what the author wrote, while the same character in prose is sentence punctuation and
  // is stripped. That difference only ever changes an `unchecked` token's text.
  it("checks the document in both syntaxes when the id is a standalone name", () => {
    const expected = [{ token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null }];
    expect(extractCitations("The pointer is node_id: report.pdf here.")).toEqual(expected);
    expect(extractCitations("[node: report.pdf] here.")).toEqual(expected);
  });

  it("reports both syntaxes as one unchecked node when the name is glued to the keyword's colon", () => {
    // Accepted, pinned consequence of the single boundary rule: with no space after the
    // colon the name is not a standalone token in the text, so neither syntax checks it.
    // `unchecked` keeps the citation, so the direction is safe.
    expect(extractCitations("[node:report.pdf] here.")).toEqual(
      extractCitations("node_id:report.pdf here."),
    );
    expect(extractCitations("[node:report.pdf] here.")).toEqual([
      { token: "node_id:report.pdf", docName: null, pages: null, nodeId: "report.pdf" },
    ]);
  });

  it("still binds an ordinary ordinal node id to the document in its sentence", () => {
    expect(extractCitations("See report.pdf, node_id: 0003.")).toEqual([
      { token: "report.pdf#n0003", docName: "report.pdf", pages: null, nodeId: "0003" },
    ]);
  });

  it("carries a trailing dot only where the syntax makes it part of the id", () => {
    // The one remaining difference between the two paths, pinned so the claim above is
    // defended rather than asserted: inside brackets the "]" ends the value, so a trailing
    // "." belongs to the id; in prose it ends the sentence and is stripped. Neither reports a
    // document, so neither can cause a deletion.
    expect(extractCitations("[node: 0003.] here.")).toEqual([
      { token: "node_id:0003.", docName: null, pages: null, nodeId: "0003." },
    ]);
    expect(extractCitations("The pointer is node_id: 0003. Here.")).toEqual([
      { token: "node_id:0003", docName: null, pages: null, nodeId: "0003" },
    ]);
  });
});

describe("extractCitations - a reserved span that merely TOUCHES a document match does not suppress it (final review: Minor 8.1)", () => {
  // The reserved-span rewrite replaced a [start, end) pair list with a byte mask, and the one
  // semantic it had to preserve - overlap suppresses, adjacency does not - was pinned by
  // nothing: changing `mask.subarray(start, end)` to `end + 1` passed the whole suite. An
  // off-by-one there deletes a real citation from the output in EVERY status, which reads to
  // a consuming agent as "nothing here needed checking".
  it("extracts a bare name whose last character abuts a quoted name's opening delimiter", () => {
    expect(extractCitations('The sources are report.pdf"annual review.pdf" today.')).toEqual([
      { token: "report.pdf", docName: "report.pdf", pages: null, nodeId: null },
      {
        token: "annual review.pdf",
        docName: "annual review.pdf",
        pages: null,
        nodeId: null,
      },
    ]);
  });
});
