import { describe, it, expect } from "vitest";
import { interpretDocResult } from "../src/pageindex-client.js";

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
