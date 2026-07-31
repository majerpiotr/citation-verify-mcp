import { describe, it, expect } from "vitest";
import { interpretDocResult, unwrap } from "../src/pageindex-client.js";

describe("interpretDocResult", () => {
  it("treats null as not found", () => {
    expect(interpretDocResult(null)).toEqual({ found: false, title: null });
  });
  it("treats an empty object as not found", () => {
    expect(interpretDocResult({})).toEqual({ found: false, title: null });
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

  it("wraps a content block with non-JSON text", () => {
    expect(unwrap({ content: [{ text: "not json" }] })).toEqual({ text: "not json" });
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
