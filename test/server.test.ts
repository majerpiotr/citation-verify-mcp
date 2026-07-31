import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { DocLookup } from "../src/pageindex-client.js";

const fake: DocLookup = {
  async getDocument(docName) {
    // `null` is the backend contract's "document does not exist" (see unwrap).
    return docName === "real-doc" ? { title: "Real Doc", status: "ready" } : null;
  },
};

const failing: DocLookup = {
  async getDocument() {
    throw new Error("backend unavailable");
  },
};

describe("createServer verify_citations tool", () => {
  it("registers the tool and returns a verdict", async () => {
    const server = createServer(fake);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(clientT);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("verify_citations");

    const res = await client.callTool({
      name: "verify_citations",
      arguments: { text: "node_id: real-doc node_id: fake-doc" },
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.total).toBe(2);
    expect(parsed.resolved).toBe(1);
    expect(parsed.unresolved).toEqual(["fake-doc"]);
  });

  // The description is the only in-band instruction a consuming agent ever gets. These
  // assertions match meaning-carrying phrases, not the whole string, so wording can be
  // tuned but a load-bearing clause cannot be dropped silently.
  it("publishes a description carrying its load-bearing clauses", async () => {
    const server = createServer(fake);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(clientT);

    const tool = (await client.listTools()).tools.find((t) => t.name === "verify_citations");
    expect(tool).toBeDefined();
    const description = tool?.description ?? "";

    // `unchecked` citations must not be deleted - the outage-safety instruction.
    expect(description).toMatch(/do not delete them/i);
    // `unresolved` is an array of tokens, not a count.
    expect(description).toMatch(/unresolved`?\s*[-:]\s*an ARRAY of tokens/i);
    // Extraction is pattern-based.
    expect(description).toMatch(/only citations written as/i);
    expect(description).toMatch(/node_id/);
    expect(description).toMatch(/recognized shape/i);
    // The false-assurance guard, asserted as one clause rather than two loose phrases:
    // `total: 0` must be tied in the same breath to "this is NOT a clean bill of health".
    // Without this, that sentence can be deleted while every other assertion here still
    // passes, and an agent reads an empty verdict as "my citations are verified".
    expect(description).toMatch(
      /total`?:?\s*0[^.;]{0,120}not that the text is free of citations/i,
    );
    // Existence is checked per document, not per page.
    expect(description).toMatch(/page reference[^.]*not verified/i);
  });

  it("publishes an input schema requiring text", async () => {
    const server = createServer(fake);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(clientT);

    const tool = (await client.listTools()).tools.find((t) => t.name === "verify_citations");
    const schema = tool?.inputSchema;
    expect(schema?.type).toBe("object");
    expect(Object.keys(schema?.properties ?? {})).toContain("text");
    expect(schema?.required).toContain("text");
  });

  it("passes a backend failure through as unchecked, never unresolved", async () => {
    const server = createServer(failing);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0.0.1" });
    await client.connect(clientT);

    const res = await client.callTool({
      name: "verify_citations",
      arguments: { text: "node_id: down-doc" },
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.unchecked).toEqual(["down-doc"]);
    expect(parsed.unresolved).toEqual([]);
    expect(parsed.details[0].status).toBe("unchecked");
  });
});
