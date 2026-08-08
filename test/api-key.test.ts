import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describeStartupFailure, isUsableApiKey, redactSecret } from "../src/api-key.js";

describe("isUsableApiKey", () => {
  it("rejects undefined", () => {
    expect(isUsableApiKey(undefined)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isUsableApiKey("")).toBe(false);
  });

  it("rejects a whitespace-only value", () => {
    expect(isUsableApiKey("   \t\n  ")).toBe(false);
  });

  // The verdict must be about the value it was GIVEN, not about a trimmed copy the
  // caller never sees. The natural reading of the API - `if (isUsableApiKey(raw))
  // connect(raw)` - must not be able to put a value into a header that is illegal
  // there. A caller that wants the trailing-newline form (`PAGEINDEX_API_KEY=$(cat
  // somefile)` style wiring) must trim at the read site, as src/index.ts does, and ask
  // about the trimmed value.
  it("rejects a key with a trailing newline, because that value is not usable as given", () => {
    expect(isUsableApiKey("sk-live-abc123XYZ\n")).toBe(false);
  });

  it("accepts the same key once the caller has trimmed it", () => {
    expect(isUsableApiKey("sk-live-abc123XYZ\n".trim())).toBe(true);
  });

  it("rejects a key surrounded by incidental whitespace, which would be sent verbatim", () => {
    expect(isUsableApiKey("  sk-live-abc123XYZ  ")).toBe(false);
  });

  it("rejects an unsubstituted shell placeholder", () => {
    expect(isUsableApiKey("${PAGEINDEX_API_KEY}")).toBe(false);
  });

  it("rejects an unsubstituted shell placeholder with surrounding whitespace", () => {
    expect(isUsableApiKey("  ${PAGEINDEX_API_KEY}  ")).toBe(false);
  });

  it("rejects a replace-with style placeholder", () => {
    expect(isUsableApiKey("replace-with-your-key")).toBe(false);
  });

  it("rejects a replace-with style placeholder regardless of case", () => {
    expect(isUsableApiKey("REPLACE-WITH-YOUR-KEY")).toBe(false);
  });

  it("rejects the your-api-key placeholder with a hyphen separator", () => {
    expect(isUsableApiKey("your-api-key")).toBe(false);
  });

  it("rejects the your-api-key placeholder with an underscore separator, any case", () => {
    expect(isUsableApiKey("YOUR_API_KEY")).toBe(false);
  });

  it("rejects the your-api-key placeholder with no separator", () => {
    expect(isUsableApiKey("yourapikey")).toBe(false);
  });

  // The README's own config blocks ship `<your-pageindex-api-key>`, and README's
  // "Startup validation" section promises the server refuses to start on an unfilled
  // placeholder. Before this case existed, the angle brackets survived the separator
  // collapse (`<yourpageindexapikey>` matched neither the literal nor the `${...}`
  // branch), so the documented placeholder was ACCEPTED and sent to the network, and the
  // operator got "Could not validate credentials" - a message about a wrong or expired
  // key - for the single most likely first-run mistake. Read out of README.md rather than
  // retyped, so the two surfaces stay pinned to each other: changing the README's
  // placeholder to something this predicate does not catch fails here.
  it("rejects every PAGEINDEX_API_KEY placeholder the README ships", () => {
    const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
    const placeholders = [...readme.matchAll(/"PAGEINDEX_API_KEY":\s*"([^"]*)"/g)].map((m) => m[1]);
    // Guards the guard: a README that stopped showing the env block at all would
    // otherwise make this vacuously green.
    expect(placeholders.length).toBeGreaterThan(0);
    for (const placeholder of placeholders) {
      expect({ placeholder, usable: isUsableApiKey(placeholder) }).toEqual({ placeholder, usable: false });
    }
  });

  it("rejects an angle-bracket-wrapped placeholder", () => {
    expect(isUsableApiKey("<your-api-key>")).toBe(false);
  });

  // No real credential is delivered wrapped in angle brackets, so the wrapper itself is
  // the signal - it catches a placeholder this predicate has never been taught by name.
  it("rejects an angle-bracket-wrapped value it has no other reason to recognize", () => {
    expect(isUsableApiKey("<paste-the-key-here>")).toBe(false);
  });

  it("rejects the your-api-key placeholder carrying the product name in the middle", () => {
    expect(isUsableApiKey("your-pageindex-api-key")).toBe(false);
  });

  it("accepts a plainly valid key", () => {
    expect(isUsableApiKey("pi-9f2c7a1b4e6d8f0a2c3b5d7e9f1a3b5c")).toBe(true);
  });

  // Over-breadth guard for the two rules above: a real key is judged on the value as a
  // whole, so neither the substring "your...api...key" nor a stray angle bracket inside a
  // key may condemn it. Both values are fabricated.
  it("still accepts a realistic key that merely contains placeholder-looking text", () => {
    expect(isUsableApiKey("pi-your-api-key-9f2c7a1b4e6d8f0a2c3b5d7e9f1a3b5c")).toBe(true);
  });

  // Verified failure chain: an embedded control character survives `.trim()` (which
  // only strips the ends), reaches `Authorization: Bearer ${apiKey}`, and throws out of
  // the SDK's Headers construction with the key quoted in the error message. Rejecting
  // it here, before it is ever used, is the first of the two required fixes.
  it("rejects a key containing an embedded newline", () => {
    expect(isUsableApiKey("pi-live-abc\nXYZ123def456")).toBe(false);
  });

  it("rejects a key containing an embedded carriage return", () => {
    expect(isUsableApiKey("pi-live-abc\rXYZ123def456")).toBe(false);
  });

  it("rejects a key containing an embedded tab", () => {
    expect(isUsableApiKey("pi-live-abc\tXYZ123def456")).toBe(false);
  });

  it("rejects a key containing a NUL byte", () => {
    expect(isUsableApiKey("pi-live-abc\x00XYZ123def456")).toBe(false);
  });

  it("still accepts an ordinary key with no control characters", () => {
    expect(isUsableApiKey("pi-live-abcXYZ123def456")).toBe(true);
  });

  // The whole contract in one case: every value this predicate calls usable must be
  // legal to interpolate into an HTTP header value verbatim. Guards against a future
  // edit reintroducing a "normalize first, answer about the normalized copy" check.
  it("calls usable only values that are legal in a header value as given", () => {
    const candidates = [
      "pi-live-abcXYZ123def456",
      "pi-live-abc\nXYZ123def456",
      "pi-live-abc\rXYZ123def456",
      "pi-live-abc\tXYZ123def456",
      "pi-live-abc\x00XYZ123def456",
      "  pi-live-abcXYZ123def456  ",
      "pi-live-abcXYZ123def456\n",
      "\npi-live-abcXYZ123def456",
    ];
    for (const candidate of candidates) {
      if (!isUsableApiKey(candidate)) continue;
      // Fabricated values only; `index` and the boolean are all that can print here.
      expect({ index: candidates.indexOf(candidate), legal: isLegalHeaderValue(candidate) }).toEqual({
        index: candidates.indexOf(candidate),
        legal: true,
      });
    }
  });
});

// Independent oracle for "would undici accept this as a header value": builds the real
// header the client builds and reports success as a boolean. Never returns, throws or
// prints the candidate, so a failure in the test above cannot put a key in the output.
function isLegalHeaderValue(candidate: string): boolean {
  try {
    const headers = new Headers({ Authorization: `Bearer ${candidate}` });
    // A value with surrounding whitespace is legal but silently normalized, so it is
    // NOT usable as given - what would be sent differs from what was passed in.
    return headers.get("Authorization") === `Bearer ${candidate}`;
  } catch {
    return false;
  }
}

describe("redactSecret", () => {
  it("replaces every occurrence of the secret with a fixed marker", () => {
    expect(redactSecret("Bearer pi-FAKE-SECRET is invalid: pi-FAKE-SECRET", "pi-FAKE-SECRET")).toBe(
      "Bearer *** is invalid: ***",
    );
  });

  it("is a no-op when the secret does not appear in the text", () => {
    expect(redactSecret("connection refused", "pi-FAKE-SECRET")).toBe("connection refused");
  });

  it("is a no-op when the secret is empty", () => {
    expect(redactSecret("connection refused", "")).toBe("connection refused");
  });
});

describe("describeStartupFailure", () => {
  // Reproduces the measured failure: undici's Headers construction quotes the invalid
  // header value - including the key - verbatim in a TypeError message.
  it("redacts the key out of an Error's message and keeps the error name", () => {
    const err = new TypeError(
      'Headers.append: "Bearer pi-FAKE-SE\nCRET-VALUE-abcdef123456" is an invalid header value.',
    );
    const rendered = describeStartupFailure(err, "pi-FAKE-SE\nCRET-VALUE-abcdef123456");
    expect(rendered).not.toContain("pi-FAKE-SE\nCRET-VALUE-abcdef123456");
    expect(rendered).toBe('TypeError: Headers.append: "Bearer ***" is an invalid header value.');
  });

  it("leaves a message that never contained the key unchanged", () => {
    const err = new Error("connection refused");
    expect(describeStartupFailure(err, "pi-FAKE-SECRET")).toBe("Error: connection refused");
  });

  it("renders a non-Error thrown value without the raw object", () => {
    expect(describeStartupFailure("boom", "pi-FAKE-SECRET")).toBe("Error: boom");
  });

  // undici puts the entire actionable signal (bad host, refused connection, self-signed
  // certificate) in `cause`; the outer error is always the same "fetch failed". Dropping
  // the chain made every network/TLS/proxy misconfiguration render as one useless line.
  it("includes the cause chain so a network or TLS failure stays diagnosable", () => {
    const err = new TypeError("fetch failed", {
      cause: new Error("connect ECONNREFUSED 127.0.0.1:1", {
        cause: new Error("self-signed certificate"),
      }),
    });
    expect(describeStartupFailure(err, "pi-FAKE-SECRET")).toBe(
      "TypeError: fetch failed <- caused by Error: connect ECONNREFUSED 127.0.0.1:1 " +
        "<- caused by Error: self-signed certificate",
    );
  });

  it("redacts the key at every level of the cause chain", () => {
    const err = new Error("outer pi-FAKE-SECRET", { cause: new Error("inner pi-FAKE-SECRET") });
    const rendered = describeStartupFailure(err, "pi-FAKE-SECRET");
    expect(rendered).not.toContain("pi-FAKE-SECRET");
    expect(rendered).toBe("Error: outer *** <- caused by Error: inner ***");
  });

  it("renders a non-Error cause without the raw object", () => {
    const err = new Error("outer", { cause: { secretish: "pi-FAKE-SECRET" } });
    const rendered = describeStartupFailure(err, "pi-FAKE-SECRET");
    expect(rendered).not.toContain("pi-FAKE-SECRET");
    expect(rendered).toBe("Error: outer <- caused by Error: [object Object]");
  });

  it("stops on a cyclic cause chain instead of looping forever", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    const rendered = describeStartupFailure(a, "pi-FAKE-SECRET");
    expect(rendered).toBe("Error: a <- caused by Error: b <- caused by [circular cause]");
  });

  it("truncates an absurdly deep cause chain", () => {
    let err = new Error("level-6");
    for (let level = 5; level >= 0; level--) {
      err = new Error(`level-${level}`, { cause: err });
    }
    const rendered = describeStartupFailure(err, "pi-FAKE-SECRET");
    expect(rendered).toBe(
      "Error: level-0 <- caused by Error: level-1 <- caused by Error: level-2 " +
        "<- caused by Error: level-3 <- caused by Error: level-4 <- caused by [cause chain truncated]",
    );
  });

  // The message rendered here is BACKEND-CONTROLLED, not merely third-party: the SDK's
  // `StreamableHTTPClientTransport` throws `Error POSTing to endpoint: ${raw response body}`
  // from inside `client.connect`, so a backend or an intercepting proxy writes this string
  // verbatim, and src/index.ts hands it straight to `exitAfterStderr` - into the log files an
  // MCP host captures. Redaction alone is not enough for that: with the control characters
  // intact, one startup failure was reproduced rendering 250 KB across THREE stderr lines,
  // one of them a forged copy of the resolver's own `citation-verify-mcp: ...` log format.
  // Same hygiene as `logLookupFailure` in src/resolver.ts, for the same reason.
  it("flattens control characters, so a hostile message cannot forge a second stderr line", () => {
    const err = new Error(
      'Error POSTing to endpoint: {"detail":"nope"}\r\n\u001b[2Jcitation-verify-mcp: ' +
        'lookup for "real-doc.pdf" could not be checked: nothing is wrong\n',
    );
    const rendered = describeStartupFailure(err, "pi-FAKE-SECRET");
    expect(rendered).toBe(
      'Error: Error POSTing to endpoint: {"detail":"nope"} [2Jcitation-verify-mcp: ' +
        'lookup for "real-doc.pdf" could not be checked: nothing is wrong',
    );
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(rendered)).toBe(false);
  });

  it("caps an absurdly long message, so a backend cannot flood the host's log files", () => {
    const rendered = describeStartupFailure(
      new Error(`Error POSTing to endpoint: ${"padding ".repeat(20_000)}`),
      "pi-FAKE-SECRET",
    );
    // 400 characters of message plus the truncation marker.
    expect(rendered.length).toBe(403);
    expect(rendered.startsWith("Error: Error POSTing to endpoint: padding")).toBe(true);
    expect(rendered.endsWith("...")).toBe(true);
  });

  // Hygiene must not cost redaction: the key still has to be gone from a message that is
  // ALSO flattened and capped. Asserted on a boolean and on the marker, so a failure here
  // cannot print the value it is guarding.
  it("still redacts the key in a message that is flattened and capped as well", () => {
    const secret = "pi-FAKE-SECRET-abcdef";
    const err = new Error(`Error POSTing to endpoint:\r\nBearer ${secret}\n${"pad ".repeat(20_000)}`);
    const rendered = describeStartupFailure(err, secret);
    expect(rendered.includes(secret)).toBe(false);
    expect(rendered.includes("***")).toBe(true);
  });

  // Flattening REWRITES the text, and any rewrite after redaction can in principle
  // reassemble the secret out of a form the redaction pass did not match. A key carrying an
  // interior space is accepted by `isUsableApiKey` (it is legal in a header value and is not
  // a placeholder), so a message quoting it with a tab or a newline where the space belongs
  // becomes the literal key the moment whitespace is collapsed. Redaction therefore has to
  // run again on the flattened text - never instead of the per-level pass, which stays the
  // one that matches the key as given.
  it("redacts a key that only becomes literal once the message is flattened", () => {
    const secret = "pi FAKE SECRET";
    expect(isUsableApiKey(secret)).toBe(true);
    const rendered = describeStartupFailure(new Error("Headers: Bearer pi\tFAKE\nSECRET"), secret);
    expect(rendered.includes(secret)).toBe(false);
  });
});
