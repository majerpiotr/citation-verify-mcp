import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { DocLookup } from "../src/pageindex-client.js";

const fake: DocLookup = {
  async getDocument(docName) {
    return docName === "real-doc" ? { title: "Real Doc", status: "ready" } : {};
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
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.total).toBe(2);
    expect(parsed.resolved).toBe(1);
    expect(parsed.unresolved).toEqual(["fake-doc"]);
  });
});
