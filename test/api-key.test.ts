import { describe, expect, it } from "vitest";
import { isUsableApiKey } from "../src/api-key.js";

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
});
