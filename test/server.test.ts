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
