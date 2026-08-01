// test/stdout-safety.test.ts
//
// This server speaks MCP over stdio: everything on stdout is protocol, not a place for
// human-readable output. A single stray `console.log` (or similar) anywhere under src/
// would corrupt every message after it and break the server for every host, silently -
// nothing in the rest of the unit suite would catch it, because none of it inspects
// stdout. This is a static source guard against that specific failure mode, not a
// linter: it does not evaluate the code, only scans the text of every file under src/.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

// `console.error` is deliberately NOT in this list: it writes to stderr, which is safe
// on an stdio transport and is where this codebase puts diagnostics on purpose (see
// src/index.ts, src/exit-after-stderr.ts). Flagging it would make this guard fail on
// legitimate, load-bearing code.
const FORBIDDEN_CALLS = [
  "console.log",
  "console.info",
  "console.debug",
  "console.dir",
  "console.table",
  "process.stdout.write",
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// Precision trade-off, stated explicitly: this strips block comments (/* ... */) and
// full-line comments (a line whose trimmed text starts with `//`) before scanning, but
// deliberately leaves inline trailing `// ...` comments alone rather than truncating
// them at the first `//`, because at least one real line in src/ contains a `//`
// INSIDE a string literal (a URL template in pageindex-client.ts's error message), and
// naively cutting there would risk silently dropping real code that follows it on the
// same line - a false negative, which is worse for this guard's purpose than a false
// positive. The residual risk this leaves - a forbidden call name appearing inside an
// inline trailing comment or a string literal - does not occur anywhere in src/ today
// (verified by grep before writing this test); a guard, not a full tokenizer, is
// enough to catch the actual failure mode this test exists for: a real call being
// added to source code.
function stripComments(source: string): string {
  const noBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlockComments
    .split("\n")
    .map((line) => (line.trim().startsWith("//") ? "" : line))
    .join("\n");
}

describe("stdout stays clean (MCP over stdio requires it)", () => {
  const files = listTsFiles(SRC_DIR);

  it("scanned at least one source file", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const relative = path.relative(path.join(SRC_DIR, ".."), file);
    it(`${relative} contains no stdout-writing call`, () => {
      const code = stripComments(readFileSync(file, "utf8"));
      for (const forbidden of FORBIDDEN_CALLS) {
        const pattern = new RegExp(`\\b${forbidden.replace(/\./g, "\\.")}\\s*\\(`);
        expect(pattern.test(code), `${relative} appears to call ${forbidden}(...)`).toBe(false);
      }
    });
  }
});
