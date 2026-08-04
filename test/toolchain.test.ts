// test/toolchain.test.ts
//
// Two DIFFERENT Node floors exist in this project and they are not interchangeable:
//
//   - the RUNTIME floor (`package.json` `engines`), what a consumer needs to run the built
//     server. Measured: the built server completes a full MCP session correctly on Node
//     20.0.0.
//   - the DEVELOPMENT floor, what a contributor needs to run `npm test`. It is higher:
//     vitest 4 bundles with rolldown, whose declared range is `^20.19.0 || >=22.12.0`.
//     Below that npm skips rolldown's native binding as engine-incompatible and the wasm
//     fallback declares the same floor, so `npm test` fails with `Cannot find native
//     binding` before any test runs, while `npm ci`, `npm run build` and `npm run
//     typecheck` still succeed.
//
//     This one is platform-dependent, which is why a single machine's green run does not
//     establish it: a clean `npm ci` on 20.13.0 installs a working binding on macOS arm64
//     and passes the whole suite, while the same commit fails on ubuntu-latest. The
//     declared range is the floor, not whatever one machine tolerates.
//
// CI used to say `node-version: ["20"]`, which setup-node resolves to the NEWEST 20.x, so
// the matrix never exercised any declared floor and could not have caught this. These
// assertions keep the two claims from drifting apart again: the version CI actually runs,
// the version the README tells a contributor to install, and the ordering between the two
// floors are pinned to each other rather than each stated on its own.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const ciWorkflow = read("../.github/workflows/ci.yml");
const readme = read("../README.md");
const manifest = JSON.parse(read("../package.json")) as {
  engines: { node: string };
  scripts: Record<string, string>;
};
const prepareScript = fileURLToPath(new URL("../scripts/prepare.mjs", import.meta.url));

function ciMatrixVersions(): string[] {
  const match = /node-version:\s*\[([^\]]*)\]/.exec(ciWorkflow);
  if (!match) throw new Error("no node-version matrix found in .github/workflows/ci.yml");
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter((entry) => entry.length > 0);
}

// Numeric, not lexicographic: "20.19.0" must sort above "20.9.0" and above "20.12.2",
// which a string comparison gets wrong.
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

// The one number the README publishes to a contributor, read out of the file so the
// README cannot claim a floor CI does not run.
function readmeDevelopmentFloor(): string {
  // Whitespace collapsed first: the README is hard-wrapped, so pinning the line break
  // positions would make this a formatting test - re-wrapping the paragraph would fail it
  // while the floor it publishes stayed correct.
  const match = /development requires Node\.js (\d+\.\d+\.\d+) or newer/i.exec(
    readme.replace(/\s+/g, " "),
  );
  if (!match) throw new Error("README.md does not publish a development Node floor");
  return match[1];
}

describe("declared Node floors", () => {
  it("pins every CI matrix entry to an exact version, never a moving major", () => {
    const versions = ciMatrixVersions();
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      // A bare "20" resolves to whatever 20.x is newest on the day the job runs, so a
      // green matrix proves nothing about the floor it was meant to represent.
      expect({ version, exact: /^\d+\.\d+\.\d+$/.test(version) }).toEqual({ version, exact: true });
    }
  });

  it("runs CI on exactly the development floor the README publishes", () => {
    const versions = ciMatrixVersions().sort(compareVersions);
    const floor = readmeDevelopmentFloor();
    expect(versions).toContain(floor);
    // Lowest, not merely present: an entry BELOW the published floor would mean CI is
    // expected to fail, and one above would leave the floor untested.
    expect(versions[0]).toBe(floor);
  });

  it("keeps the development floor at or above the runtime floor `engines` declares", () => {
    const runtimeFloor = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(manifest.engines.node);
    if (!runtimeFloor) throw new Error("engines.node declares no version");
    const runtime = `${runtimeFloor[1]}.${runtimeFloor[2] ?? 0}.${runtimeFloor[3] ?? 0}`;
    // `engines` is the CONSUMER's requirement and is deliberately the looser of the two.
    // Inverting them would tell a contributor that a version which cannot run the suite is
    // good enough to develop on.
    expect(compareVersions(readmeDevelopmentFloor(), runtime)).toBeGreaterThanOrEqual(0);
  });
});

// The build has to run in three places and must NOT run in a fourth:
//
//   - `npm pack` and `npm publish`, or the tarball ships without `dist/` (that is why
//     `prepublishOnly` was not enough: it does not run on `npm pack`);
//   - a git-URL install, where npm clones the repo, installs devDependencies and runs
//     `prepare` - the only hook that fires there;
//   - a contributor's plain `npm install`;
//   - NOT on a production install. `npm ci --omit=dev` and `npm install --omit=dev` run
//     `prepare` too, but deliberately do not install devDependencies, so the build it used
//     to launch could not work: `sh: tsc: command not found`, npm exits non-zero and the
//     whole install fails. That is the standard Dockerfile and deployment incantation, and
//     CI cannot catch it because CI runs a full `npm ci`.
//
// `prepare` therefore stays the hook (the first three cases need it) and the DECISION moves
// into a script, which is what these assertions cover. A config-shape assertion would only
// restate package.json; these run the real script, in a real directory, and check what it
// does.
describe("the prepare hook builds when it can and stands aside when it cannot", () => {
  function runPrepare(cwd: string, env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, [prepareScript], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, npm_execpath: undefined, ...env },
    });
  }

  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "prepare-guard-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
    return dir;
  }

  it("is still wired to the `prepare` lifecycle hook", () => {
    // Pinned because the three cases above depend on the HOOK, not on the script: moving it
    // to `prepublishOnly` silently restores a code-free `npm pack` tarball, and moving it to
    // `prepack` silently breaks the git-URL install.
    expect(manifest.scripts.prepare).toMatch(/scripts\/prepare\.mjs/);
  });

  it("exits 0 without building when the local toolchain is absent", () => {
    const dir = scratch();
    try {
      const result = runPrepare(dir);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
      // It must not have shelled out to a build it cannot run - that is the failure this
      // guard exists for, and an exit code of 0 alone would not prove it.
      expect(result.stdout).not.toMatch(/tsc|npm run build/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still fails the install when the toolchain IS present and the build fails", () => {
    // The tempting one-liner for this problem - `... && npm run build || exit 0` - swallows
    // a real compile error too, and would publish an empty or stale `dist/` with a green
    // exit code. The script must pass the build's own status through untouched.
    const dir = scratch();
    try {
      mkdirSync(join(dir, "node_modules", "typescript"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "typescript", "package.json"), "{}");
      const stub = join(dir, "fake-npm.mjs");
      writeFileSync(stub, "process.exit(3);\n");
      const result = runPrepare(dir, { npm_execpath: stub });
      expect(result.status).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs the build when the toolchain is present", () => {
    const dir = scratch();
    try {
      mkdirSync(join(dir, "node_modules", "typescript"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "typescript", "package.json"), "{}");
      const stub = join(dir, "fake-npm.mjs");
      writeFileSync(stub, "console.log(process.argv.slice(2).join(\" \"));\n");
      const result = runPrepare(dir, { npm_execpath: stub });
      expect({ status: result.status, stdout: result.stdout.trim() }).toEqual({
        status: 0,
        stdout: "run build",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
