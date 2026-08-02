// test/pageindex-client.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { redactSecret } from "../src/api-key.js";
import {
  interpretGetDocument,
  collectNodeIds,
  shouldFetchNextStructurePart,
  accumulateNodeIds,
  assertSecureBaseUrl,
  PageindexHttpClient,
} from "../src/pageindex-client.js";

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

  // A resolver bounds-checks a cited page against 1..pageCount. `page_count: 0` (e.g.
  // while a document's status is not yet "completed") would make every valid page
  // citation fall outside that range and get reported `unresolved` - and deleted. Only
  // a positive integer is a usable page count; anything else is `null`, which already
  // means "not checked, the document verdict stands" - the document is still `found`.
  it("reports pageCount null (not 0) when page_count is zero", () => {
    const res = textResult({ success: true, name: "some-doc.pdf", page_count: 0 });
    expect(interpretGetDocument(res)).toEqual({
      found: true,
      doc: { name: "some-doc.pdf", pageCount: null },
    });
  });

  it("reports pageCount null when page_count is negative", () => {
    const res = textResult({ success: true, name: "some-doc.pdf", page_count: -3 });
    expect(interpretGetDocument(res)).toEqual({
      found: true,
      doc: { name: "some-doc.pdf", pageCount: null },
    });
  });

  it("reports pageCount null when page_count is fractional", () => {
    const res = textResult({ success: true, name: "some-doc.pdf", page_count: 5.5 });
    expect(interpretGetDocument(res)).toEqual({
      found: true,
      doc: { name: "some-doc.pdf", pageCount: null },
    });
  });

  // similar_files elements that aren't strings are not a usable "did you mean" list.
  it("falls back to an empty similar list when similar_files contains non-strings", () => {
    const res = textResult(
      {
        error: "Document not found.",
        errorCode: "NOT_FOUND",
        doc_name: "missing.pdf",
        similar_files: ["ok.pdf", 5, null],
      },
      true,
    );
    expect(interpretGetDocument(res)).toEqual({ found: false, similar: [] });
  });

  // A body carrying both `success: true` and `isError: true` is not a positive,
  // unambiguous statement that the document exists - it must not short-circuit past
  // the isError channel.
  it("throws when success is true but the envelope also reports isError", () => {
    const res = textResult({ success: true, name: "some-doc.pdf", page_count: 56 }, true);
    expect(() => interpretGetDocument(res)).toThrow();
  });

  // An empty name hands the resolver a title that isn't really a title. Ambiguous, not
  // a usable positive statement about the document.
  it("throws when success is true but name is an empty string", () => {
    const res = textResult({ success: true, name: "", page_count: 56 });
    expect(() => interpretGetDocument(res)).toThrow();
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

  it("throws when a node's nodes field is present but not an array", () => {
    const structure = [{ title: "Chapter", node_id: "0000", nodes: "not-an-array" }];
    expect(() => collectNodeIds(structure)).toThrow();
  });

  // The direction (throw, not silently truncate) was already safe even without a
  // guard - a cyclic or pathologically deep tree would blow the call stack, which is
  // also a throw. But an unguarded RangeError isn't diagnosable. A shallow, cheap depth
  // guard makes the failure name itself; no realistic outline nests anywhere near it.
  it("throws a diagnosable error on a pathologically deep tree, not a raw stack overflow", () => {
    let node: Record<string, unknown> = { title: "leaf", node_id: "id-999" };
    for (let i = 998; i >= 0; i--) {
      node = { title: `level-${i}`, node_id: `id-${i}`, nodes: [node] };
    }
    let message: string | null = null;
    try {
      collectNodeIds([node]);
      throw new Error("expected collectNodeIds to throw");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toBeNull();
    expect(message).not.toMatch(/Maximum call stack/i);
    expect(message?.toLowerCase()).toMatch(/depth|deep|nest/);
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

// Wraps a get_document_structure body the way the SDK's callTool() would.
function structureResult(body: unknown, isError = false): unknown {
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError };
}

// The paging loop is exactly where under-collection would silently produce a false
// `unresolved` (a real node id that IS in the document looking absent), so it must be
// exercised directly - not just the has_more decision in isolation. Per the plan, the
// HTTP transport itself stays untested; this injects only the "fetch one part" seam
// (no mock MCP client), so `fetchPart` here stands in for one `callTool` round trip.
describe("accumulateNodeIds", () => {
  it("collects ids from a single part with no pagination block", async () => {
    const fetchPart = async (part: number) => {
      expect(part).toBe(1);
      return structureResult({
        success: true,
        doc_name: "some-doc.pdf",
        structure: [
          { title: "Intro", node_id: "0000" },
          { title: "Body", node_id: "0001" },
        ],
      });
    };
    const ids = await accumulateNodeIds("some-doc.pdf", fetchPart);
    expect(ids).toEqual(new Set(["0000", "0001"]));
  });

  it("accumulates a union across two parts", async () => {
    const calls: number[] = [];
    const fetchPart = async (part: number) => {
      calls.push(part);
      if (part === 1) {
        return structureResult({
          success: true,
          structure: [{ title: "A", node_id: "0000" }, { title: "B", node_id: "0001" }],
          pagination: { has_more: true },
        });
      }
      return structureResult({
        success: true,
        structure: [{ title: "C", node_id: "0002" }],
        // Observed live: pagination is simply absent on the last part.
      });
    };
    const ids = await accumulateNodeIds("some-doc.pdf", fetchPart);
    expect(calls).toEqual([1, 2]);
    expect(ids).toEqual(new Set(["0000", "0001", "0002"]));
  });

  it("collapses duplicate ids across parts", async () => {
    const fetchPart = async (part: number) => {
      if (part === 1) {
        return structureResult({
          success: true,
          structure: [{ title: "A", node_id: "0000" }, { title: "B", node_id: "0001" }],
          pagination: { has_more: true },
        });
      }
      return structureResult({
        success: true,
        structure: [{ title: "B again", node_id: "0001" }, { title: "C", node_id: "0002" }],
      });
    };
    const ids = await accumulateNodeIds("some-doc.pdf", fetchPart);
    expect(ids).toEqual(new Set(["0000", "0001", "0002"]));
    expect(ids.size).toBe(3);
  });

  // Fix 1: an empty first part is ambiguous, not a positive statement that the
  // document has no nodes - a document with genuinely zero nodes cannot have a validly
  // cited node anyway, so `unchecked` (via a throw) is both safe and honest.
  it("throws when the first part yields no node ids at all", async () => {
    const fetchPart = async () => structureResult({ success: true, structure: [] });
    await expect(accumulateNodeIds("some-doc.pdf", fetchPart)).rejects.toThrow();
  });

  // A later part adding nothing new is fine - only an EMPTY FIRST part is suspicious.
  it("does not throw when a later part adds no new ids", async () => {
    const fetchPart = async (part: number) => {
      if (part === 1) {
        return structureResult({
          success: true,
          structure: [{ title: "A", node_id: "0000" }],
          pagination: { has_more: true },
        });
      }
      return structureResult({ success: true, structure: [] });
    };
    const ids = await accumulateNodeIds("some-doc.pdf", fetchPart);
    expect(ids).toEqual(new Set(["0000"]));
  });

  // Without a cap, a backend that always reports has_more:true would loop forever.
  // Exceeding it must THROW, never return the partial set collected so far - a partial
  // set would make a real node id look absent and produce a false `unresolved`.
  it("throws when the pagination cap is exceeded, without returning a partial set", async () => {
    let calls = 0;
    const fetchPart = async (part: number) => {
      calls += 1;
      return structureResult({
        success: true,
        structure: [{ title: `Node ${part}`, node_id: `id-${part}` }],
        pagination: { has_more: true },
      });
    };
    await expect(accumulateNodeIds("some-doc.pdf", fetchPart)).rejects.toThrow();
    // The cap was actually hit, not some unrelated early failure.
    expect(calls).toBeGreaterThan(1);
  });

  // parseStructurePage must not read a `structure` key out of an errored response.
  it("throws when a part reports isError, even if the body has a structure key", async () => {
    const fetchPart = async () =>
      structureResult({ error: "PageIndex API returned 503", structure: [] }, true);
    await expect(accumulateNodeIds("some-doc.pdf", fetchPart)).rejects.toThrow();
  });
});

describe("assertSecureBaseUrl", () => {
  it("accepts the default https origin", () => {
    expect(() => assertSecureBaseUrl(new URL("https://api.pageindex.ai/mcp"))).not.toThrow();
  });

  it("accepts plain http on localhost", () => {
    expect(() => assertSecureBaseUrl(new URL("http://localhost:3000/mcp"))).not.toThrow();
  });

  it("accepts plain http on 127.0.0.1", () => {
    expect(() => assertSecureBaseUrl(new URL("http://127.0.0.1:3000/mcp"))).not.toThrow();
  });

  it("accepts https on a non-loopback host", () => {
    expect(() => assertSecureBaseUrl(new URL("https://self-hosted.example.com/mcp"))).not.toThrow();
  });

  it("rejects plain http on a non-loopback host, so the bearer token can't go out in plaintext", () => {
    expect(() => assertSecureBaseUrl(new URL("http://api.pageindex.ai/mcp"))).toThrow(/https/);
  });

  it("rejects a non-http(s) scheme", () => {
    expect(() => assertSecureBaseUrl(new URL("ftp://api.pageindex.ai/mcp"))).toThrow(/https/);
  });

  // A local development backend bound to ::1 (increasingly the default) is loopback and
  // must be reachable over plain http, like its IPv4 twin. WHATWG URL normalizes any
  // spelling of the IPv6 loopback address to the compressed bracketed form, so an exact
  // match on "[::1]" covers "[0:0:0:0:0:0:0:1]" too without widening the exception.
  it("accepts plain http on the IPv6 loopback address", () => {
    expect(() => assertSecureBaseUrl(new URL("http://[::1]:3000/mcp"))).not.toThrow();
  });

  it("accepts plain http on the uncompressed spelling of IPv6 loopback", () => {
    expect(() => assertSecureBaseUrl(new URL("http://[0:0:0:0:0:0:0:1]:3000/mcp"))).not.toThrow();
  });

  // Re-verification of the bypass attempts a previous review confirmed the guard
  // survives, pinned here so the IPv6 addition above cannot quietly widen the exception.
  // Each entry is [url, must be accepted]. The accepted plain-http ones are genuinely
  // loopback (127.1 and 0x7f.1 both normalize to 127.0.0.1; "evil.com@localhost" is
  // userinfo, and the host really is localhost).
  it("still rejects every non-loopback form that looks loopback", () => {
    const cases: Array<[string, boolean]> = [
      ["HTTP://LOCALHOST:3000/mcp", true],
      ["http://127.1:3000/mcp", true],
      ["http://0x7f.1:3000/mcp", true],
      ["http://evil.com@localhost:3000/mcp", true],
      ["http://localhost.evil.com/mcp", false],
      ["http://localhost@evil.com/mcp", false],
      ["http://127.0.0.2:3000/mcp", false],
      ["http://[::ffff:127.0.0.1]:3000/mcp", false],
      ["http://[::2]:3000/mcp", false],
      ["http://127.0.0.1.evil.com/mcp", false],
      ["http://xn--localhost-/mcp", false],
      ["ftp://localhost:3000/mcp", false],
    ];
    const accepted = cases.filter(([url]) => {
      try {
        assertSecureBaseUrl(new URL(url));
        return true;
      } catch {
        return false;
      }
    });
    expect(accepted.map(([url]) => url)).toEqual(cases.filter(([, ok]) => ok).map(([url]) => url));
  });
});

// `connect` is the one function that interpolates the API key into an Authorization
// header, and it is called directly with a LIVE key by test/integration.test.ts. Without
// a guard of its own, a key carrying an embedded control character (a wrapped paste, a
// two-line key file) reaches undici, which quotes the whole invalid header value -
// key included - in a TypeError that a test runner or an MCP host then prints. The guard
// in src/index.ts does not cover this: it protects one of `connect`'s callers, not
// `connect`, which is exported and reachable by embedders too.
describe("PageindexHttpClient.connect key guard", () => {
  // Fabricated, never derived from any real key.
  const UNUSABLE_KEY = "pi-FAKE-ONE-aaaa\npi-FAKE-TWO-bbbb";
  const USABLE_FAKE_KEY = "pi-FAKE-USABLE-cccc";

  // Reports the outcome as data that is safe to print: a boolean for "did the message
  // quote the key", plus a copy of the message with the key redacted out of it. Nothing
  // that could carry the key verbatim ever reaches `expect`, so a failure here cannot
  // become the very leak this block is about.
  async function connectOutcome(apiKey: string): Promise<{ quotedKey: boolean; message: string }> {
    try {
      await PageindexHttpClient.connect(apiKey);
      return { quotedKey: false, message: "<connect resolved without throwing>" };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      return { quotedKey: raw.includes(apiKey), message: redactSecret(raw, apiKey) };
    }
  }

  // Points every case in this block at a closed loopback port, so a `connect` that got
  // past the guard fails locally instead of reaching out to the real backend.
  const originalBaseUrl = process.env["PAGEINDEX_BASE_URL"];
  beforeEach(() => {
    process.env["PAGEINDEX_BASE_URL"] = "http://127.0.0.1:1/mcp";
  });
  afterEach(() => {
    if (originalBaseUrl === undefined) delete process.env["PAGEINDEX_BASE_URL"];
    else process.env["PAGEINDEX_BASE_URL"] = originalBaseUrl;
  });

  it("refuses a key with an embedded control character before it can reach a header", async () => {
    const outcome = await connectOutcome(UNUSABLE_KEY);
    expect(outcome.quotedKey).toBe(false);
    expect(outcome.message).toMatch(/API key is unusable/);
    expect(outcome.message).toMatch(/value is not shown/);
  });

  it("does not refuse an otherwise usable key - it fails on the connection instead", async () => {
    const outcome = await connectOutcome(USABLE_FAKE_KEY);
    expect(outcome.quotedKey).toBe(false);
    expect(outcome.message).not.toMatch(/API key is unusable/);
  });
});

// Pins the wire contract itself: the exact tool name and argument key
// PageindexHttpClient sends. Established empirically against the live backend
// (docs/spike-b-findings.md section 4) and NOT covered by interpretGetDocument /
// accumulateNodeIds above, which only test how a response is read - not what request
// produced it. `doc_name` (not `doc_id`) and a 1-based `part` are both load-bearing:
// get either wrong and the backend returns a validation error on every call, which
// interpretGetDocument turns into a throw, so every citation becomes `unchecked`
// forever (CLAUDE.md hard rule 4) while the rest of this suite stays green. Uses
// PageindexHttpClient.forTesting to inject a fake ToolCaller that records every
// {name, arguments} pair - no network, no API key, no real MCP transport.
describe("PageindexHttpClient wire contract", () => {
  it("calls get_document with tool name get_document and argument key doc_name", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const client = PageindexHttpClient.forTesting({
      async callTool(params) {
        calls.push(params);
        return textResult({ success: true, name: "report.pdf", page_count: 12 });
      },
    });

    const result = await client.getDocument("report.pdf");

    expect(calls).toEqual([{ name: "get_document", arguments: { doc_name: "report.pdf" } }]);
    expect(result).toEqual({ found: true, doc: { name: "report.pdf", pageCount: 12 } });
  });

  it("calls get_document_structure with argument key doc_name and a 1-based part", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const client = PageindexHttpClient.forTesting({
      async callTool(params) {
        calls.push(params);
        return structureResult({
          success: true,
          structure: [{ title: "Intro", node_id: "0000" }],
          // No pagination block: the observed single-part shape, so exactly one call.
        });
      },
    });

    const ids = await client.getNodeIds("report.pdf");

    expect(calls).toEqual([
      { name: "get_document_structure", arguments: { doc_name: "report.pdf", part: 1 } },
    ]);
    expect(ids).toEqual(new Set(["0000"]));
  });

  it("pages get_document_structure with an increasing 1-based part, never part: 0", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const client = PageindexHttpClient.forTesting({
      async callTool(params) {
        calls.push(params);
        if (params.arguments["part"] === 1) {
          return structureResult({
            success: true,
            structure: [{ title: "A", node_id: "0000" }],
            pagination: { has_more: true },
          });
        }
        return structureResult({ success: true, structure: [{ title: "B", node_id: "0001" }] });
      },
    });

    await client.getNodeIds("report.pdf");

    expect(calls).toEqual([
      { name: "get_document_structure", arguments: { doc_name: "report.pdf", part: 1 } },
      { name: "get_document_structure", arguments: { doc_name: "report.pdf", part: 2 } },
    ]);
  });
});
