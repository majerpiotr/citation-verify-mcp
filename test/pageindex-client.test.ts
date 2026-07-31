import { describe, it, expect } from "vitest";
import { interpretDocResult, unwrap } from "../src/pageindex-client.js";

describe("interpretDocResult", () => {
  it("treats null as not found", () => {
    expect(interpretDocResult(null)).toEqual({ found: false, title: null });
  });
  // An empty envelope is ambiguous - it is not a positive statement that the document
  // is absent, so it must become `unchecked`, never `unresolved` (CLAUDE.md hard rule 4).
  it("throws on an empty object rather than calling it not found", () => {
    expect(() => interpretDocResult({})).toThrow();
  });
  it("treats an object with all-falsy values as not found", () => {
    expect(interpretDocResult({ title: "", status: null })).toEqual({ found: false, title: null });
  });
  it("treats a populated doc as found and extracts title", () => {
    expect(interpretDocResult({ title: "Some Doc", status: "ready" })).toEqual({
      found: true,
      title: "Some Doc",
    });
  });
  it("is found even without a title field", () => {
    expect(interpretDocResult({ status: "ready" })).toEqual({ found: true, title: null });
  });
});

describe("unwrap", () => {
  it("returns structuredContent when present", () => {
    expect(unwrap({ structuredContent: { title: "Doc", status: "ready" } })).toEqual({
      title: "Doc",
      status: "ready",
    });
  });

  it("parses a content block with JSON text", () => {
    expect(unwrap({ content: [{ text: '{"title":"Doc"}' }] })).toEqual({ title: "Doc" });
  });

  it("returns null for a content block whose JSON text is literally null", () => {
    expect(unwrap({ content: [{ text: "null" }] })).toBeNull();
  });

  // Unparseable text is not a document. Reporting it as a payload would let a plain-text
  // backend error ("401 Unauthorized") be read as a resolved document.
  it("throws on a content block with non-JSON text", () => {
    expect(() => unwrap({ content: [{ text: "401 Unauthorized: invalid API key" }] })).toThrow(
      /401 Unauthorized/,
    );
  });

  it("truncates the excerpt of a large non-JSON payload in the error message", () => {
    const huge = "x".repeat(5000);
    let message: string | null = null;
    try {
      unwrap({ content: [{ text: huge }] });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).not.toBeNull();
    // Bounds the WHOLE message: well above the excerpt cap plus its prefix, far below the
    // 5000-character payload. Removing the cap blows straight through this.
    expect(message?.length ?? 0).toBeLessThan(400);
    // Still diagnosable, and visibly marked as truncated.
    expect(message).toMatch(/x{50}/);
    expect(message).toMatch(/\.\.\.$/);
  });

  it("throws on JSON that is not an object", () => {
    expect(() => unwrap({ content: [{ text: "false" }] })).toThrow();
    expect(() => unwrap({ content: [{ text: "0" }] })).toThrow();
    expect(() => unwrap({ content: [{ text: '"a string"' }] })).toThrow();
  });

  it("throws on a JSON array payload", () => {
    expect(() => unwrap({ content: [{ text: "[1,2]" }] })).toThrow();
  });

  it("throws when content is empty", () => {
    expect(() => unwrap({ content: [] })).toThrow();
  });

  it("throws when the content block has no text field", () => {
    expect(() => unwrap({ content: [{}] })).toThrow();
  });

  it("throws when the tool call reports isError", () => {
    expect(() => unwrap({ isError: true, content: [{ text: "Error: PageIndex API returned 503" }] })).toThrow();
  });
});
