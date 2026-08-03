// src/version.ts
//
// The ONE source of the version this server advertises - to the MCP host (src/server.ts)
// and to the PageIndex backend (src/pageindex-client.ts). Both used to hardcode "0.0.1"
// while package.json held a third copy, so the first `npm version patch` would have made
// the server advertise a version it is not.
//
// package.json is the source, read at startup rather than imported: `tsconfig.json` sets
// `rootDir: "src"`, so a JSON import of a file outside `src/` would not compile, and
// bundling the value at build time would put the copy back. `../package.json` resolves
// against THIS module's own URL, which is `<pkg>/src/` in development and `<pkg>/dist/`
// in the published package - the package root either way, and npm always ships
// package.json regardless of the `files` list.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Used only if package.json cannot be read or carries no usable version (e.g. the module
// was bundled into some other layout). Deliberately not a plausible-looking version: a
// wrong number would be worse than an obviously unknown one.
const UNKNOWN_VERSION = "0.0.0-unknown";

function readPackageVersion(): string {
  try {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const version = (parsed as Record<string, unknown>)["version"];
      if (typeof version === "string" && version.length > 0) return version;
    }
  } catch {
    // Falls through to UNKNOWN_VERSION: a version string is metadata, never a reason to
    // refuse to start.
  }
  return UNKNOWN_VERSION;
}

export const SERVER_VERSION = readPackageVersion();
