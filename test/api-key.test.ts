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

  it("accepts a key that is only usable after trimming a trailing newline", () => {
    // e.g. PAGEINDEX_API_KEY=$(cat somefile) style wiring
    expect(isUsableApiKey("sk-live-abc123XYZ\n")).toBe(true);
  });

  it("accepts a key surrounded by incidental whitespace", () => {
    expect(isUsableApiKey("  sk-live-abc123XYZ  ")).toBe(true);
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
});

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
});
