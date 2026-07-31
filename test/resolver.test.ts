import { describe, it, expect } from "vitest";
import { verifyCitations } from "../src/resolver.js";
import type { DocLookup } from "../src/pageindex-client.js";

function fakeClient(map: Record<string, Record<string, unknown> | null | "throw">): DocLookup {
  return {
    async getDocument(docName) {
      const v = map[docName];
      if (v === "throw") throw new Error("backend down");
      return v ?? null;
    },
  };
}

describe("verifyCitations", () => {
  it("classifies resolved, unresolved, unchecked", async () => {
    const text = "node_id: real-doc node_id: fake-doc node_id: down-doc";
    const client = fakeClient({
      "real-doc": { title: "Real Doc", status: "ready" },
      // `null` is how the backend contract states "this document does not exist"
      // (see unwrap in src/pageindex-client.ts).
      "fake-doc": null,
      "down-doc": "throw",
    });
    const r = await verifyCitations(text, client);
    expect(r.total).toBe(3);
    expect(r.resolved).toBe(1);
    expect(r.unresolved).toEqual(["fake-doc"]);
    expect(r.unchecked).toEqual(["down-doc"]);
    expect(r.details).toContainEqual({ token: "real-doc", status: "resolved", title: "Real Doc" });
  });

  it("returns an empty verdict for no citations", async () => {
    const r = await verifyCitations("plain prose", fakeClient({}));
    expect(r).toEqual({ total: 0, resolved: 0, unresolved: [], unchecked: [], details: [] });
  });

  it("never marks a backend failure as unresolved", async () => {
    const client = fakeClient({ "x-doc": "throw" });
    const r = await verifyCitations("node_id: x-doc", client);
    expect(r.unresolved).toEqual([]);
    expect(r.unchecked).toEqual(["x-doc"]);
  });

  it("treats an ambiguous backend payload as unchecked, never unresolved", async () => {
    const client: DocLookup = {
      async getDocument() {
        // An empty envelope from a degraded backend: not a positive statement of absence.
        return {};
      },
    };
    const r = await verifyCitations("node_id: maybe-doc", client);
    expect(r.unresolved).toEqual([]);
    expect(r.unchecked).toEqual(["maybe-doc"]);
  });

  it("asks the backend for the docName, not the raw token, while reporting the full token", async () => {
    const requestedDocNames: string[] = [];
    const client: DocLookup = {
      async getDocument(docName) {
        requestedDocNames.push(docName);
        return { title: "Report", status: "ready" };
      },
    };
    const text = "See report.pdf, p. 3 and report.pdf page 7.";
    const r = await verifyCitations(text, client);

    // One lookup per distinct document, not per token: two page tokens of the same
    // document must not cost two sequential backend round trips.
    expect(requestedDocNames).toEqual(["report.pdf"]);
    expect(r.details.map((d) => d.token)).toEqual(["report.pdf#p3", "report.pdf#p7"]);
    expect(r.details.map((d) => d.status)).toEqual(["resolved", "resolved"]);
    expect(r.details.map((d) => d.title)).toEqual(["Report", "Report"]);
    expect(r.total).toBe(2);
  });

  it("reuses a failed lookup for every token of the same document", async () => {
    let calls = 0;
    const client: DocLookup = {
      async getDocument() {
        calls += 1;
        throw new Error("backend down");
      },
    };
    const r = await verifyCitations("See report.pdf p.3 and report.pdf p.7.", client);

    expect(calls).toBe(1);
    expect(r.unchecked).toEqual(["report.pdf#p3", "report.pdf#p7"]);
    expect(r.unresolved).toEqual([]);
    expect(r.total).toBe(r.details.length);
  });
});
