// test/server.test.ts
//
// Drives the real MCP server over InMemoryTransport with a real MCP Client and a fake
// DocLookup (docs/rework-plan.md "Target interfaces") - offline, no key, no network.
// Covers: tool registration and input schema, an end-to-end resolved+unresolved call, the
// unresolved-vs-unchecked invariant at THIS layer (CLAUDE.md hard rule 4 - a throw from the
// client must surface as `unchecked`, never `unresolved`), the `suggestion` field
// round-tripping, and the tool description's load-bearing clauses (docs/rework-plan.md Task
// R4) pinned by meaning-carrying regexes rather than a verbatim string pin.
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { DocLookup, DocLookupResult } from "../src/pageindex-client.js";

interface FakeConfig {
  documents?: Record<string, DocLookupResult | "throw">;
}

function fakeClient(config: FakeConfig): DocLookup {
  return {
    async getDocument(docName) {
      const v = config.documents?.[docName];
      if (v === "throw") throw new Error("backend unavailable");
      if (v === undefined) throw new Error(`test fixture missing for getDocument("${docName}")`);
      return v;
    },
    async getNodeIds() {
      return new Set<string>();
    },
  };
}

async function connectedClient(client: DocLookup): Promise<Client> {
  const server = createServer(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new Client({ name: "test", version: "0.0.1" });
  await mcpClient.connect(clientTransport);
  return mcpClient;
}

describe("createServer verify_citations tool", () => {
  it("registers the tool with a required text input", async () => {
    const mcpClient = await connectedClient(fakeClient({}));
    const tools = await mcpClient.listTools();
    const tool = tools.tools.find((t) => t.name === "verify_citations");
    expect(tool).toBeDefined();
    const schema = tool?.inputSchema;
    expect(schema?.type).toBe("object");
    expect(Object.keys(schema?.properties ?? {})).toContain("text");
    expect(schema?.required).toContain("text");
  });

  it("resolves an existing document and reports a fabricated one unresolved", async () => {
    const mcpClient = await connectedClient(
      fakeClient({
        documents: {
          "real-doc.pdf": { found: true, doc: { name: "real-doc.pdf", pageCount: 10 } },
          "fake-doc.pdf": { found: false, similar: [] },
        },
      }),
    );

    const res = await mcpClient.callTool({
      name: "verify_citations",
      arguments: { text: "See real-doc.pdf for the numbers, but fake-doc.pdf is fabricated." },
    });

    // Assert isError falsy BEFORE parsing, so a genuine failure surfaces its real message
    // instead of a confusing JSON.parse error.
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.total).toBe(2);
    expect(parsed.resolved).toBe(1);
    expect(parsed.unresolved).toEqual(["fake-doc.pdf"]);
    expect(parsed.unchecked).toEqual([]);
  });

  it("passes a backend throw through as unchecked, never unresolved", async () => {
    const mcpClient = await connectedClient(fakeClient({ documents: { "down-doc.pdf": "throw" } }));

    const res = await mcpClient.callTool({
      name: "verify_citations",
      arguments: { text: "See down-doc.pdf for details." },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.unchecked).toEqual(["down-doc.pdf"]);
    expect(parsed.unresolved).toEqual([]);
    expect(parsed.details[0].status).toBe("unchecked");
  });

  it("carries a near-miss suggestion through to the client", async () => {
    const mcpClient = await connectedClient(
      fakeClient({
        documents: {
          "near-miss.pdf": { found: false, similar: ["Near-Miss.pdf"] },
        },
      }),
    );

    const res = await mcpClient.callTool({
      name: "verify_citations",
      arguments: { text: "See near-miss.pdf for details." },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.details[0].status).toBe("unresolved");
    expect(parsed.details[0].suggestion).toMatch(/Near-Miss\.pdf/);
  });

  // The description is the only in-band instruction a consuming agent ever gets. Every
  // assertion below targets a SINGLE load-bearing clause with a phrase that appears nowhere
  // else in the description - each one was mutation-tested individually (see
  // .superpowers/sdd/implementation-plan/r4-report.md) to confirm it actually discriminates:
  // deleting only the clause it guards fails that assertion while the rest stay green.
  // Two prior traps are specifically guarded against here:
  //   1. a clause that is restated more than once must have EVERY occurrence covered by a
  //      wording specific enough that a single surviving occurrence can't save it (e.g. the
  //      "to"-range and page-shape assertions below pin the literal example list, not a
  //      generic word like "recognized").
  //   2. the MCP-error "never AS `unresolved`" clause and the bare-node "never `unresolved`"
  //      clause are DIFFERENT sentences and are pinned by two DIFFERENT regexes - a single
  //      `/never .?unresolved/i` regex silently matches only one of them.
  it("publishes a description carrying its load-bearing clauses", async () => {
    const mcpClient = await connectedClient(fakeClient({}));
    const tool = (await mcpClient.listTools()).tools.find((t) => t.name === "verify_citations");
    const description = tool?.description ?? "";

    // --- output shape ---
    // `unresolved` is an array of tokens, not a count.
    expect(description).toMatch(/unresolved`?\s*-\s*an ARRAY of tokens confirmed absent from the corpus/i);
    // `unchecked` is an array too, and "no key" must NOT be listed as a reason - with no key
    // the process never serves the tool at all (Minor).
    expect(description).toMatch(/unchecked`?\s*-\s*an ARRAY of tokens the check could not run for/i);
    expect(description).not.toMatch(/no key/i);
    // `total` counts DISTINCT canonical tokens - repeats of the same document collapse to
    // one (Minor).
    expect(description).toMatch(/count of DISTINCT recognized-shape citations \(repeated citations of the same document collapse to one\)/i);
    // `suggestion` is described as something to act on, not just a field name.
    expect(description).toMatch(/suggestion`? may carry a near-miss document name/i);

    // --- Critical 3: a `resolved` verdict can carry an unverified page ---
    expect(description).toMatch(
      /should be acted on - including on a `?resolved`? verdict: when the backend reports no page count, a cited page is not bounds-checked and the citation can still resolve/i,
    );
    expect(description).toMatch(/the page itself was never verified/i);
    expect(description).toMatch(/cited page falls within the document's real page count, only when the backend reports one/i);
    expect(description).toMatch(/cited node id exists in the document's real outline/i);

    // --- outage-safety imperatives ---
    expect(description).toMatch(/do not delete them/i);
    // MCP-error clause - deliberately distinct from the bare-node "never `unresolved`" clause
    // below (Important 5, defect 1): this one reads "never AS `unresolved`".
    expect(description).toMatch(
      /treat every citation in the text as `?unchecked`? in that case, never as `?unresolved/i,
    );

    // --- Critical 1: hyphen, en dash AND the word "to" are all accepted range separators ---
    expect(description).toMatch(/hyphen, en dash, or the word "to" all separate a range/i);

    // --- recognized shapes, pinned to the literal example list (Important 5, defect 2: a
    // generic word like "recognized" can be satisfied elsewhere, so this pins the actual
    // examples) ---
    expect(description).toMatch(/`p\.5`, `pp\. 5-7`, `page 12`, `pages 5 to 7`/);
    // node_id with both separators documented (Minor).
    expect(description).toMatch(/`node_id: <id>`? or `?node_id=<id>`/);
    // page/node keywords are case-insensitive; the document name is not (Minor + existing).
    expect(description).toMatch(/page and node keywords case-insensitive/i);
    expect(description).toMatch(/matched CASE-SENSITIVELY/);

    // --- Critical 2: the accepted same-line forms, and what's NOT checked ---
    expect(description).toMatch(/connector \(`on`\/`at`\/`see`\)/);
    expect(description).toMatch(/inside `\(\)`\/`\[\]`/);
    expect(description).toMatch(/on the SAME LINE, with no other document name in between/i);
    expect(description).toMatch(/a page written any other way is not checked/i);

    // --- quoting rule and its limits ---
    expect(description).toMatch(/wrapped in double quotes or backticks/i);
    expect(description).toMatch(
      /file-name-shaped \(at most 4 words, at most 80 characters, no apostrophe, `&`, a comma, a colon, or a non-ASCII character\)/i,
    );
    expect(description).toMatch(/Single quotes are NOT a delimiter/i);

    // --- Important 6: a rejected/space-bearing name is silently checked as A DIFFERENT
    // document, not merely left unverified - and `title` is the way to catch it ---
    expect(description).toMatch(/silently checked AS `?Report\.pdf`?, a DIFFERENT document/);
    expect(description).toMatch(/check `?title`? on a `?resolved`? verdict to catch this/i);

    // --- bare node_id rule ---
    expect(description).toMatch(/reported `?unchecked`?, never `?unresolved`? - node numbering is per-document/i);
    expect(description).toMatch(/node id alone identifies nothing/i);

    // --- the false-assurance guard: `total: 0` tied in the same breath to "not a clean bill
    // of health" ---
    expect(description).toMatch(/total`?:?\s*0[^.;]{0,200}not a clean bill of health/i);
    // --- combined page+node citation returns one verdict ---
    expect(description).toMatch(/carrying both a page and a node returns ONE verdict/i);

    // --- Important 4: the canonical token shape, so an agent can map a token back to its
    // own draft, and can tell "page checked" from "page dropped" ---
    expect(description).toMatch(/`<document>`? optionally followed by `#p<page-or-range>`/);
    expect(description).toMatch(/`#n<node-id>`? alone, or `&n<node-id>`? when a page precedes it/);
    expect(description).toMatch(/`node_id:<id>`? for a bare node/);
  });

  it("gives the text parameter a description", async () => {
    const mcpClient = await connectedClient(fakeClient({}));
    const tool = (await mcpClient.listTools()).tools.find((t) => t.name === "verify_citations");
    const schema = tool?.inputSchema as { properties?: Record<string, { description?: string }> } | undefined;
    expect(schema?.properties?.["text"]?.description).toMatch(/draft text/i);
  });
});
