import { describe, expect, it } from "vitest";
import {
  extractPartialJsonStringValue,
  extractPartialReplies,
} from "./helpers.ts";

describe("extractPartialReplies", () => {
  it("returns nothing before the first id lands", () => {
    expect(extractPartialReplies('{"replies":[{"comme')).toEqual([]);
  });

  it("reports an id whose text has not started", () => {
    expect(extractPartialReplies('{"replies":[{"commentId":"c1","te')).toEqual([
      { commentId: "c1", text: "" },
    ]);
  });

  it("grows the text as it streams", () => {
    expect(
      extractPartialReplies('{"replies":[{"commentId":"c1","text":"line\\none'),
    ).toEqual([{ commentId: "c1", text: "line\none" }]);
  });

  it("keeps each reply with its own comment", () => {
    expect(
      extractPartialReplies(
        '{"replies":[{"commentId":"c1","text":"a"},{"commentId":"c2","text":"b"}]}',
      ),
    ).toEqual([
      { commentId: "c1", text: "a" },
      { commentId: "c2", text: "b" },
    ]);
  });

  it("does not borrow the next reply's text", () => {
    expect(
      extractPartialReplies(
        '{"replies":[{"commentId":"c1"},{"commentId":"c2","text":"b"}]}',
      ),
    ).toEqual([
      { commentId: "c1", text: "" },
      { commentId: "c2", text: "b" },
    ]);
  });
});

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
