import { describe, it, expect } from "vitest";
import { extractPartialJsonStringValue } from "./helpers.ts";

describe("extractPartialJsonStringValue", () => {
  it("extracts a complete string value", () => {
    const json = '{"script": "file `foo`"}';
    expect(extractPartialJsonStringValue(json, "script")).toBe("file `foo`");
  });

  it("extracts a partial string value (incomplete JSON)", () => {
    const json = '{"script": "file `foo`\\nsel';
    expect(extractPartialJsonStringValue(json, "script")).toBe(
      "file `foo`\nsel",
    );
  });

  it("returns undefined when key is not present", () => {
    expect(extractPartialJsonStringValue('{"scr', "script")).toBe(undefined);
  });

  it("returns undefined when colon is not present", () => {
    expect(extractPartialJsonStringValue('{"script"', "script")).toBe(
      undefined,
    );
  });

  it("returns undefined when opening quote is not present", () => {
    expect(extractPartialJsonStringValue('{"script": ', "script")).toBe(
      undefined,
    );
  });

  it("returns empty string for empty value", () => {
    expect(extractPartialJsonStringValue('{"script": ""}', "script")).toBe("");
  });

  it("unescapes JSON escape sequences", () => {
    const json = '{"script": "line1\\nline2\\ttab\\\\backslash\\/slash"}';
    expect(extractPartialJsonStringValue(json, "script")).toBe(
      "line1\nline2\ttab\\backslash/slash",
    );
  });

  it("unescapes escaped quotes", () => {
    const json = '{"script": "say \\"hello\\""}';
    expect(extractPartialJsonStringValue(json, "script")).toBe('say "hello"');
  });

  it("unescapes unicode escapes", () => {
    const json = '{"script": "\\u0041\\u0042"}';
    expect(extractPartialJsonStringValue(json, "script")).toBe("AB");
  });

  it("handles trailing backslash at end of partial JSON", () => {
    const json = '{"script": "hello\\';
    expect(extractPartialJsonStringValue(json, "script")).toBe("hello");
  });

  it("handles just the opening of the string value", () => {
    const json = '{"script": "';
    expect(extractPartialJsonStringValue(json, "script")).toBe("");
  });
});
