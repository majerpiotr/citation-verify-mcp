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
//
// Every console method that writes to STDOUT belongs here, not just the obvious printing
// ones: `group`/`groupCollapsed`/`groupEnd`, `count`/`countReset` and
// `time`/`timeEnd`/`timeLog` all emit their label, tally or duration on stdout in Node, so
// any one of them dropped into src/ corrupts the protocol stream exactly as a stray
// `console.log` would. The list is verified against synthetic source below - scanning src/,
// which is clean, can never show that a listed name is actually detected.
const FORBIDDEN_CALLS = [
  "console.log",
  "console.info",
  "console.debug",
  "console.dir",
  "console.table",
  "console.group",
  "console.groupCollapsed",
  "console.groupEnd",
  "console.count",
  "console.countReset",
  "console.time",
  "console.timeEnd",
  "console.timeLog",
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

// The single detector both the scan below and its own self-test use. Extracted so the guard
// can be tested against synthetic source: src/ is clean today, so scanning src/ alone can
// never demonstrate that a newly listed call would actually be caught - it passes either
// way. A guard nobody has seen fail is a guard nobody has verified.
function findForbiddenCall(code: string): string | null {
  const stripped = stripComments(code);
  for (const forbidden of FORBIDDEN_CALLS) {
    const pattern = new RegExp(`\\b${forbidden.replace(/\./g, "\\.")}\\s*\\(`);
    if (pattern.test(stripped)) return forbidden;
  }
  return null;
}

describe("the stdout guard detects every console method that writes to stdout", () => {
  // Every one of these writes to STDOUT in Node, which on this server carries the MCP
  // protocol stream: `console.group`/`groupCollapsed`/`groupEnd` (indentation control plus
  // the group label), `count`/`countReset` (the tally line), and `time`/`timeEnd`/`timeLog`
  // (the duration line) all go to the same stream as `console.log`. A single one of them
  // added to src/ would corrupt every protocol message after it, exactly like a stray
  // `console.log` - so the guard must name them.
  const STDOUT_WRITERS = [
    "console.log",
    "console.info",
    "console.debug",
    "console.dir",
    "console.table",
    "console.group",
    "console.groupCollapsed",
    "console.groupEnd",
    "console.count",
    "console.countReset",
    "console.time",
    "console.timeEnd",
    "console.timeLog",
    "process.stdout.write",
  ];

  for (const call of STDOUT_WRITERS) {
    it(`flags ${call}(...)`, () => {
      expect(findForbiddenCall(`function f() {\n  ${call}("x");\n}\n`)).toBe(call);
    });
  }

  // `console.error` writes to stderr, which is safe on an stdio transport and is where this
  // codebase puts diagnostics on purpose. Flagging it would make the guard fail on real,
  // load-bearing code (src/index.ts), so its absence from the list is asserted, not assumed.
  it("does not flag console.error, which writes to stderr", () => {
    expect(findForbiddenCall(`console.error("startup failed");`)).toBeNull();
  });

  // The comment-stripping half of the detector, pinned so a future simplification of
  // stripComments cannot turn a prose mention of a forbidden name into a false positive.
  it("ignores a forbidden name that appears only in a full-line comment", () => {
    expect(findForbiddenCall(`// never call console.log(...) here\nconst x = 1;\n`)).toBeNull();
  });
});

describe("stdout stays clean (MCP over stdio requires it)", () => {
  const files = listTsFiles(SRC_DIR);

  it("scanned at least one source file", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const relative = path.relative(path.join(SRC_DIR, ".."), file);
    it(`${relative} contains no stdout-writing call`, () => {
      const found = findForbiddenCall(readFileSync(file, "utf8"));
      expect(found, `${relative} appears to call ${found}(...)`).toBeNull();
    });
  }
});
