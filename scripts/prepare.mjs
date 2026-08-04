// scripts/prepare.mjs
//
// The `prepare` lifecycle hook, with one decision in front of it: build only when the
// toolchain that does the building is actually installed.
//
// `prepare` is the hook this project needs, and no other one covers the same three cases:
// `prepublishOnly` does not run on `npm pack` (so a tarball could ship with no `dist/`),
// and `prepack` does not run on a git-URL install (where npm clones the repo, installs
// devDependencies, and runs `prepare` to produce the built files it will then pack).
//
// But `prepare` also runs on `npm ci --omit=dev` and `npm install --omit=dev`, which
// deliberately do NOT install devDependencies - so `tsc` is absent, the build exits
// "command not found", and the entire production install fails. That is the standard
// deployment and Dockerfile incantation, and a full `npm ci` in CI cannot catch it.
//
// So: no toolchain, no build, exit 0. The install proceeds and simply installs no source of
// its own, which is what a production install of a package's dependencies is for.
//
// What this deliberately does NOT do is swallow a build FAILURE. The tempting one-liner
// (`node -e "...exists?0:1" && npm run build || exit 0`) treats a real compile error as a
// success and would publish an empty or stale `dist/` with a green exit code. The build's
// own status is passed through untouched.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// npm runs lifecycle scripts with the package root as cwd. Checked by PATH-independent
// existence rather than by resolving "typescript", so an unrelated copy hoisted into an
// ancestor directory cannot make this claim the local toolchain is present.
const root = process.cwd();
const hasToolchain =
  existsSync(join(root, "node_modules", "typescript")) ||
  existsSync(join(root, "node_modules", ".bin", "tsc"));

if (!hasToolchain) {
  process.exit(0);
}

// Reuse the npm that invoked this script when there is one (`npm_execpath`), so a build
// launched from `npm ci` uses the same npm and not whatever is first on PATH. It points at
// a JavaScript entry point in every npm release, but check rather than assume: a shell
// wrapper must be executed, not handed to node.
const execPath = process.env.npm_execpath;
const runsUnderNode = execPath !== undefined && /\.[cm]?js$/.test(execPath);
const result = execPath
  ? runsUnderNode
    ? spawnSync(process.execPath, [execPath, "run", "build"], { stdio: "inherit", cwd: root })
    : spawnSync(execPath, ["run", "build"], { stdio: "inherit", cwd: root })
  : spawnSync("npm", ["run", "build"], {
      stdio: "inherit",
      cwd: root,
      shell: process.platform === "win32",
    });

if (result.error) {
  console.error(`prepare: could not run the build: ${result.error.message}`);
  process.exit(1);
}
// A build killed by a signal reports status null; that is a failure, not a success.
process.exit(result.status ?? 1);
