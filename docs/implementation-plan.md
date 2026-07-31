# citation-verify-mcp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone, pluggable MCP server (`verify_citations`) that deterministically checks whether an agent's citations resolve against PageIndex.

**Architecture:** A Node/TypeScript MCP server on `@modelcontextprotocol/sdk`, distributed via `npx`. It extracts citation tokens from a draft text, resolves each against PageIndex by wrapping `pageindex-mcp` (spawned as a child MCP server), and returns a structured verdict (`resolved` / `unresolved` / `unchecked`). The core (grammar, resolver, server surface) depends on a `DocLookup` interface so it is unit-testable with a fake client; only the concrete PageIndex client touches the network.

**Tech Stack:** Node 20+, TypeScript, `@modelcontextprotocol/sdk`, `vitest`, `tsx`. Wraps `pageindex-mcp` (npm). Design: [design.md](design.md).

## Global Constraints

- Language: Node/TypeScript. Runnable via `npx`. Node 20+ required.
- Standalone project. No dependency on, or reference to, any specific consuming host.
- v0 scope is existence-only. No database, no gateway, no reuse detection, no
  quote-overlap, no grounding/NLI, no self-correction. (design.md section 2.)
- The verdict distinguishes `unresolved` (checked, not found) from `unchecked` (could
  not check). A backend failure must never surface as `unresolved`. (C2.)
- The server is self-sufficient: it reads its own `PAGEINDEX_API_KEY` from its own env.
  (C3.)
- Its key + folder scope must point at the same PageIndex account/folder the citing
  agent uses. (C1.)
- Comments and code in English. Work on a feature branch, not `main`.
- Repo is already initialized at the project root (paths below are repo-root-relative).

## File Structure

- `package.json` - package manifest, bin, deps, scripts.
- `tsconfig.json` - TypeScript config.
- `vitest.config.ts` - test config.
- `src/grammar.ts` - citation extraction + token splitting (pure).
- `src/pageindex-client.ts` - `DocLookup` interface, `interpretDocResult` (pure), `PageindexMcpClient` (concrete, network).
- `src/resolver.ts` - `verifyCitations` core + verdict types.
- `src/server.ts` - MCP server surface, registers `verify_citations`.
- `src/index.ts` - bin entry: wire concrete client + server + stdio transport.
- `test/grammar.test.ts`, `test/pageindex-client.test.ts`, `test/resolver.test.ts`, `test/server.test.ts`
- `test/integration.test.ts` - real pageindex-mcp, skipped without credentials.
- `README.md` - install / plug-in instructions.

---

## Phase 0 - Spikes (do first; investigation, not TDD)

These de-risk the two load-bearing assumptions. They need a real `PAGEINDEX_API_KEY`
and a known-good `doc_id`. They gate Task 2 (grammar) and Task 7 (integration), but do
NOT block Tasks 1-6 (built against a fake client).

### Spike A: Confirm the real citation format

- [ ] Collect representative outputs from the consuming agent(s) and grep for candidate
  citation shapes (`node_id:` tokens, `<doc>.pdf p.<N>`, bare references).
- [ ] **Exit criteria:** a written list of the exact token shapes to support in the
  grammar (Task 2).
- [ ] **Decision gate:** if agents emit no resolvable tokens, the premise depends on
  host-side instruction forcing a resolvable form; record this and add a grammar entry
  for whatever form they do emit.

### Spike B: Confirm the wrap transport in the target runtime

- [ ] With a valid `PAGEINDEX_API_KEY`, run a throwaway script that spawns
  `npx -y pageindex-mcp` via the MCP SDK stdio client and calls `get_document` for one
  known-good `doc_id` and one fabricated id.
- [ ] Record the response shape for both and whether the bare token matches `doc_name`
  or `doc_id`.
- [ ] **Exit criteria:** the concrete `get_document` argument shape and the
  found-vs-not-found discriminator (feeds Task 3 and Task 7).
- [ ] **Decision gate:** if `npx` spawn is problematic, switch the concrete client to a
  direct `api.pageindex.ai` call (fallback). The `DocLookup` interface is unchanged, so
  Tasks 1-6 are unaffected.

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`

**Interfaces:**
- Produces: an `npm test`-runnable, `npm run build`-buildable TS package.

- [x] **Step 1: Create `package.json`**

```json
{
  "name": "citation-verify-mcp",
  "version": "0.0.1",
  "description": "MCP server that verifies whether agent citations resolve against PageIndex",
  "type": "module",
  "bin": { "citation-verify-mcp": "dist/index.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "dev": "tsx src/index.ts"
  },
  "engines": { "node": ">=20" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.27.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

- [x] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [x] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
```

- [x] **Step 4: Ensure `.gitignore` (already created with secret protection; keep these entries)**

```
node_modules/
dist/

# secrets - never commit
key.txt
*.key
.env
.env.*
```

- [x] **Step 5: Install and verify**

Run: `npm install && npm test`
Expected: vitest runs and reports "no test files found" cleanly.

- [x] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore docs/ CLAUDE.md
git commit -m "chore: scaffold citation-verify-mcp package + docs"
```

---

## Task 2: Citation grammar

**Files:**
- Create: `src/grammar.ts`
- Test: `test/grammar.test.ts`

**Interfaces:**
- Produces:
  - `extractCitations(text: string): string[]` - unique tokens, first-seen order.
  - `splitToken(token: string): { docName: string; pages: string | null }`

- [x] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { extractCitations, splitToken } from "../src/grammar.js";

describe("extractCitations", () => {
  it("extracts node_id tokens", () => {
    const text = "See node_id: some-doc-id-123 for details.";
    expect(extractCitations(text)).toEqual(["some-doc-id-123"]);
  });

  it("extracts doc.pdf page references as doc.pdf#pN", () => {
    const text = "As stated in report.pdf p.5 and manual.pdf page 12.";
    expect(extractCitations(text)).toEqual(["report.pdf#p5", "manual.pdf#p12"]);
  });

  it("dedupes preserving first-seen order", () => {
    const text = "node_id: a node_id: b node_id: a";
    expect(extractCitations(text)).toEqual(["a", "b"]);
  });

  it("returns empty array when no citations", () => {
    expect(extractCitations("plain prose, no tokens")).toEqual([]);
  });
});

describe("splitToken", () => {
  it("splits a page token without doubling .pdf", () => {
    expect(splitToken("report.pdf#p5")).toEqual({ docName: "report.pdf", pages: "5" });
  });
  it("returns bare token as docName with null pages", () => {
    expect(splitToken("some-doc-id-123")).toEqual({ docName: "some-doc-id-123", pages: null });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/grammar.test.ts`
Expected: FAIL - cannot find module `../src/grammar.js`.

- [x] **Step 3: Write minimal implementation**

```ts
// src/grammar.ts
const RE_NODE_ID = /node_id[:=]\s*([A-Za-z0-9_\-./#]+)/g;
const RE_DOC_PAGE = /([A-Za-z0-9_\-]+)\.pdf\s*(?:p\.|page\s+)(\d+(?:-\d+)?)/gi;

export function extractCitations(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(RE_NODE_ID)) seen.add(m[1]);
  for (const m of text.matchAll(RE_DOC_PAGE)) seen.add(`${m[1]}.pdf#p${m[2]}`);
  return [...seen];
}

export function splitToken(token: string): { docName: string; pages: string | null } {
  if (token.includes("#p")) {
    const idx = token.indexOf("#p");
    return { docName: token.slice(0, idx), pages: token.slice(idx + 2) };
  }
  return { docName: token, pages: null };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/grammar.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/grammar.ts test/grammar.test.ts
git commit -m "feat: citation grammar extraction and token split"
```

---

## Task 3: PageIndex client interface + result interpretation

**Files:**
- Create: `src/pageindex-client.ts`
- Test: `test/pageindex-client.test.ts`

**Interfaces:**
- Produces:
  - `interface DocLookup { getDocument(docName: string): Promise<Record<string, unknown> | null> }`
  - `interpretDocResult(raw: Record<string, unknown> | null): { found: boolean; title: string | null }`
  - `class PageindexMcpClient implements DocLookup` (concrete; network glue, covered by Task 7).

- [x] **Step 1: Write the failing test (pure `interpretDocResult`)**

```ts
import { describe, it, expect } from "vitest";
import { interpretDocResult } from "../src/pageindex-client.js";

describe("interpretDocResult", () => {
  it("treats null as not found", () => {
    expect(interpretDocResult(null)).toEqual({ found: false, title: null });
  });
  it("treats an empty object as not found", () => {
    expect(interpretDocResult({})).toEqual({ found: false, title: null });
  });
  it("treats an object with all-falsy values as not found", () => {
    expect(interpretDocResult({ title: "", status: null })).toEqual({ found: false, title: null });
  });
  it("treats a populated doc as found and extracts title", () => {
    expect(interpretDocResult({ title: "Some Doc", status: "ready" })).toEqual({
      found: true,
      title: "Some Doc",
    });
  });
  it("is found even without a title field", () => {
    expect(interpretDocResult({ status: "ready" })).toEqual({ found: true, title: null });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/pageindex-client.test.ts`
Expected: FAIL - module not found.

- [x] **Step 3: Write minimal implementation**

```ts
// src/pageindex-client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface DocLookup {
  getDocument(docName: string): Promise<Record<string, unknown> | null>;
}

export function interpretDocResult(
  raw: Record<string, unknown> | null,
): { found: boolean; title: string | null } {
  if (!raw) return { found: false, title: null };
  const values = Object.values(raw);
  const found = values.length > 0 && values.some((v) => Boolean(v));
  const rawTitle = raw["title"];
  const title = typeof rawTitle === "string" && rawTitle ? rawTitle : null;
  return { found, title };
}

// Concrete client. Spawns pageindex-mcp and dispatches get_document over stdio.
// Network glue - exercised by test/integration.test.ts, not the unit suite.
// NOTE: finalize the get_document argument shape after Spike B (doc_name vs doc_id).
export class PageindexMcpClient implements DocLookup {
  private client: Client;

  private constructor(client: Client) {
    this.client = client;
  }

  static async connect(apiKey: string): Promise<PageindexMcpClient> {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["-y", "pageindex-mcp"],
      env: { ...process.env, PAGEINDEX_API_KEY: apiKey },
    });
    const client = new Client({ name: "citation-verify", version: "0.0.1" });
    await client.connect(transport);
    return new PageindexMcpClient(client);
  }

  async getDocument(docName: string): Promise<Record<string, unknown> | null> {
    const res = await this.client.callTool({
      name: "get_document",
      arguments: { doc_name: docName },
    });
    return unwrap(res);
  }
}

function unwrap(res: unknown): Record<string, unknown> | null {
  const structured = (res as { structuredContent?: Record<string, unknown> }).structuredContent;
  if (structured) return structured;
  const content = (res as { content?: Array<{ text?: string }> }).content ?? [];
  for (const block of content) {
    if (block.text) {
      try {
        return JSON.parse(block.text) as Record<string, unknown>;
      } catch {
        return { text: block.text };
      }
    }
  }
  return null;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/pageindex-client.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/pageindex-client.ts test/pageindex-client.test.ts
git commit -m "feat: PageIndex DocLookup interface, result interpretation, mcp client"
```

---

## Task 4: Resolver core

**Files:**
- Create: `src/resolver.ts`
- Test: `test/resolver.test.ts`

**Interfaces:**
- Consumes: `extractCitations`, `splitToken` (Task 2); `DocLookup`, `interpretDocResult` (Task 3).
- Produces:
  - `type CitationStatus = "resolved" | "unresolved" | "unchecked"`
  - `interface CitationDetail { token: string; status: CitationStatus; title: string | null }`
  - `interface VerifyResult { total: number; resolved: number; unresolved: string[]; unchecked: string[]; details: CitationDetail[] }`
  - `verifyCitations(text: string, client: DocLookup): Promise<VerifyResult>`

- [x] **Step 1: Write the failing test (with a fake client)**

```ts
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
      "fake-doc": {},
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
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/resolver.test.ts`
Expected: FAIL - module not found.

- [x] **Step 3: Write minimal implementation**

```ts
// src/resolver.ts
import { extractCitations, splitToken } from "./grammar.js";
import { interpretDocResult, type DocLookup } from "./pageindex-client.js";

export type CitationStatus = "resolved" | "unresolved" | "unchecked";

export interface CitationDetail {
  token: string;
  status: CitationStatus;
  title: string | null;
}

export interface VerifyResult {
  total: number;
  resolved: number;
  unresolved: string[];
  unchecked: string[];
  details: CitationDetail[];
}

export async function verifyCitations(text: string, client: DocLookup): Promise<VerifyResult> {
  const tokens = extractCitations(text);
  const details: CitationDetail[] = [];

  for (const token of tokens) {
    const { docName } = splitToken(token);
    try {
      const raw = await client.getDocument(docName);
      const { found, title } = interpretDocResult(raw);
      details.push({ token, status: found ? "resolved" : "unresolved", title });
    } catch {
      details.push({ token, status: "unchecked", title: null });
    }
  }

  return {
    total: tokens.length,
    resolved: details.filter((d) => d.status === "resolved").length,
    unresolved: details.filter((d) => d.status === "unresolved").map((d) => d.token),
    unchecked: details.filter((d) => d.status === "unchecked").map((d) => d.token),
    details,
  };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/resolver.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/resolver.ts test/resolver.test.ts
git commit -m "feat: citation resolver with resolved/unresolved/unchecked verdict"
```

---

## Task 5: MCP server surface

**Files:**
- Create: `src/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `verifyCitations` (Task 4); `DocLookup` (Task 3).
- Produces: `createServer(client: DocLookup): McpServer` - an MCP server exposing the `verify_citations` tool.

- [x] **Step 1: Write the failing test (in-memory transport, fake client)**

```ts
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
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL - module not found.

- [x] **Step 3: Write minimal implementation**

```ts
// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { verifyCitations } from "./resolver.js";
import type { DocLookup } from "./pageindex-client.js";

export function createServer(client: DocLookup): McpServer {
  const server = new McpServer({ name: "citation-verify", version: "0.0.1" });

  server.registerTool(
    "verify_citations",
    {
      description:
        "Check whether the citations in the given text resolve against PageIndex. " +
        "Returns resolved / unresolved (checked, not found) / unchecked (could not check).",
      inputSchema: { text: z.string() },
    },
    async ({ text }) => {
      const result = await verifyCitations(text, client);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  return server;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/server.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/server.ts test/server.test.ts
git commit -m "feat: MCP server surface exposing verify_citations"
```

---

## Task 6: Binary entry point

**Files:**
- Create: `src/index.ts`

**Interfaces:**
- Consumes: `PageindexMcpClient` (Task 3), `createServer` (Task 5).
- Produces: an executable that connects the server over stdio - the `npx` entry point.

- [x] **Step 1: Write the implementation**

```ts
// src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PageindexMcpClient } from "./pageindex-client.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const apiKey = process.env.PAGEINDEX_API_KEY;
  if (!apiKey || apiKey.startsWith("replace-with")) {
    console.error("PAGEINDEX_API_KEY missing or placeholder. Set it in the mcp_servers env block.");
    process.exit(1);
  }
  const client = await PageindexMcpClient.connect(apiKey);
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("citation-verify-mcp failed to start:", err);
  process.exit(1);
});
```

- [x] **Step 2: Build to verify it compiles**

Run: `npm run build`
Expected: `dist/index.js` produced, no TypeScript errors.

- [x] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: stdio bin entry point"
```

---

## Task 7: Integration test against real PageIndex

**Files:**
- Create: `test/integration.test.ts`

**Interfaces:**
- Consumes: `PageindexMcpClient` (Task 3), `verifyCitations` (Task 4). Uses Spike B findings for the real id and response shape.

- [ ] **Step 1: Write the integration test (skipped without credentials)**

```ts
import { describe, it, expect } from "vitest";
import { PageindexMcpClient } from "../src/pageindex-client.js";
import { verifyCitations } from "../src/resolver.js";

const apiKey = process.env.PAGEINDEX_API_KEY;
const realDoc = process.env.CITATION_VERIFY_TEST_DOC_ID; // a known-good doc id
const hasEnv = Boolean(apiKey) && !apiKey!.startsWith("replace-with") && Boolean(realDoc);

describe.runIf(hasEnv)("integration: real PageIndex", () => {
  it("resolves a real doc and flags a fabricated one", async () => {
    const client = await PageindexMcpClient.connect(apiKey!);
    const text = `node_id: ${realDoc} node_id: does-not-exist-zzz-0000`;
    const r = await verifyCitations(text, client);
    expect(r.details.find((d) => d.token === realDoc)?.status).toBe("resolved");
    expect(r.unresolved).toContain("does-not-exist-zzz-0000");
  }, 60_000);
});
```

- [ ] **Step 2: Run with credentials**

Run: `PAGEINDEX_API_KEY=<key> CITATION_VERIFY_TEST_DOC_ID=<real-doc-id> npx vitest run test/integration.test.ts`
Expected: PASS. If the real doc resolves as `unresolved`, revisit the `get_document`
argument shape from Spike B (doc_name vs doc_id) and adjust `PageindexMcpClient.getDocument`.

- [ ] **Step 3: Commit**

```bash
git add test/integration.test.ts
git commit -m "test: integration against real PageIndex, credential-gated"
```

---

## Task 8: README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: the built server (Tasks 1-6).

- [ ] **Step 1: Write the README**

````markdown
# citation-verify-mcp

A pluggable MCP server that checks whether an agent's citations resolve against
PageIndex. Existence is verified deterministically (no model in the trust path).

## Plug in

Add to your MCP host config:

```yaml
mcp_servers:
  citation-verify:
    command: npx
    args: ["-y", "citation-verify-mcp"]
    env:
      PAGEINDEX_API_KEY: "${PAGEINDEX_API_KEY}"
      # PAGEINDEX_FOLDER_ID optional; defaults to "root". Must match the folder
      # the citing agent uses.
```

Unplug: remove the block.

## Tool

`verify_citations(text: string)` -> `{ total, resolved, unresolved[], unchecked[], details[] }`.
- `unresolved` = checked against the corpus, not found.
- `unchecked` = could not be checked (no key, timeout, backend down). Do not delete
  those citations.

## Host integration

Instruct your agent: "Before finalizing, call `verify_citations` on your draft. For each
`unresolved` citation, remove the claim or search again and replace it with a real
citation. Leave `unchecked` citations in place with a note."
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: plug-in README"
```

---

## Self-Review

- **Design coverage:** existence check (Tasks 2-4, 7), stateless (no DB anywhere),
  pluggable Node/TS via npx (Tasks 1, 6, 8), unresolved vs unchecked (Task 4),
  self-sufficiency/own key (Task 6), same-scope note (README, C1), wrap transport
  (Task 3), spikes A/B (Phase 0). Covered.
- **Placeholder scan:** no TBD/TODO; every code step has real code; the only deferred
  detail (exact `get_document` arg shape) is gated on Spike B with an adjustment note
  in Task 7.
- **Type consistency:** `DocLookup`, `interpretDocResult`, `verifyCitations`,
  `VerifyResult`, `createServer`, `PageindexMcpClient` names/signatures match across
  Tasks 3-7.

## Notes / deferred (not in scope)

Gateway observer, audit log/trend, reuse detection, quote-overlap, grounding/NLI +
calibrated confidence, bounded self-correction, CI eval gate. See design.md section 12.
