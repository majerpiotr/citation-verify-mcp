import { describe, expect, it } from "vitest";
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

  it("accepts a plainly valid key", () => {
    expect(isUsableApiKey("pi-9f2c7a1b4e6d8f0a2c3b5d7e9f1a3b5c")).toBe(true);
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
});
