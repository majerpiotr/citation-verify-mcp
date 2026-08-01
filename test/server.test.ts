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

  // The description is the only in-band instruction a consuming agent ever gets. These
  // assertions match meaning-carrying phrases, not the whole string, so wording can be
  // tuned but a load-bearing clause cannot be dropped silently.
  it("publishes a description carrying its load-bearing clauses", async () => {
    const mcpClient = await connectedClient(fakeClient({}));
    const tool = (await mcpClient.listTools()).tools.find((t) => t.name === "verify_citations");
    const description = tool?.description ?? "";

    // `unchecked` citations must not be deleted - the outage-safety imperative.
    expect(description).toMatch(/do not delete them/i);
    // `unresolved` is an array of tokens, not a count.
    expect(description).toMatch(/unresolved`?\s*[-:]\s*an ARRAY of tokens/i);
    // Extraction is pattern-based, over a fixed set of recognized shapes.
    expect(description).toMatch(/recognized shape/i);
    // The false-assurance guard, asserted as one clause so `total: 0` and "not a clean
    // bill of health" cannot drift apart - dropping either half of the tie must fail this.
    expect(description).toMatch(/total`?:?\s*0[^.;]{0,200}not a clean bill of health/i);
    // What is actually verified: document, page bounds, node membership.
    expect(description).toMatch(/page[^.]*within the document's real page count/i);
    expect(description).toMatch(/node[^.]*document's real outline/i);
    // The quoting rule for a space-bearing document name.
    expect(description).toMatch(/double quotes or backticks/i);
    // The bare node_id rule.
    expect(description).toMatch(/bare `?node_id/i);
    expect(description).toMatch(/never `?unresolved/i);
    // `suggestion` is described, not just listed as a field name.
    expect(description).toMatch(/suggestion[^.]*near-miss/i);
  });

  it("gives the text parameter a description", async () => {
    const mcpClient = await connectedClient(fakeClient({}));
    const tool = (await mcpClient.listTools()).tools.find((t) => t.name === "verify_citations");
    const schema = tool?.inputSchema as { properties?: Record<string, { description?: string }> } | undefined;
    expect(schema?.properties?.["text"]?.description).toMatch(/draft text/i);
  });
});
