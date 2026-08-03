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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const ciWorkflow = read("../.github/workflows/ci.yml");
const readme = read("../README.md");
const manifest = JSON.parse(read("../package.json")) as { engines: { node: string } };

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
