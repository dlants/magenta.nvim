import { describe, expect, it } from "vitest";
import {
  AT_FILE_PATTERN,
  extractFileRefPath,
  formatFileRef,
  unescapeFenceBody,
} from "./files.ts";

describe("unescapeFenceBody", () => {
  it("decodes \\\\ to a single backslash", () => {
    expect(unescapeFenceBody("a\\\\b")).toBe("a\\b");
  });

  it("decodes \\` to a single backtick", () => {
    expect(unescapeFenceBody("a\\`b")).toBe("a`b");
  });

  it("preserves unknown escape pairs literally", () => {
    expect(unescapeFenceBody("a\\nb")).toBe("a\\nb");
  });

  it("preserves trailing lone backslash", () => {
    expect(unescapeFenceBody("a\\")).toBe("a\\");
  });
});

describe("AT_FILE_PATTERN + extractFileRefPath", () => {
  function parseAll(input: string): string[] {
    const regex = new RegExp(AT_FILE_PATTERN.source, "g");
    const results: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(input)) !== null) {
      results.push(extractFileRefPath(m));
    }
    return results;
  }

  it("matches a bare path", () => {
    expect(parseAll("@file:foo/bar.txt")).toEqual(["foo/bar.txt"]);
  });

  it("matches a length-1 fenced path with spaces", () => {
    expect(parseAll("@file:`foo bar.txt`")).toEqual(["foo bar.txt"]);
  });

  it("matches a length-2 fenced path with a single backtick", () => {
    expect(parseAll("@file:``foo`bar.txt``")).toEqual(["foo`bar.txt"]);
  });

  it("matches a length-2 fenced path with escaped backticks", () => {
    expect(parseAll("@file:``foo\\`\\`bar.txt``")).toEqual(["foo``bar.txt"]);
  });

  it("matches a length-2 fenced path with escaped backslashes", () => {
    expect(parseAll("@file:``C:\\\\path``")).toEqual(["C:\\path"]);
  });

  it("finds multiple refs in one string", () => {
    expect(parseAll("start @file:a.txt middle @file:`b c.txt` end")).toEqual([
      "a.txt",
      "b c.txt",
    ]);
  });
});

describe("formatFileRef", () => {
  it("uses bare form for simple paths", () => {
    expect(formatFileRef("foo/bar.txt")).toBe("@file:foo/bar.txt");
  });

  it("uses length-1 fence for whitespace-only paths", () => {
    expect(formatFileRef("foo bar.txt")).toBe("@file:`foo bar.txt`");
  });

  it("uses length-2 fence when path contains backticks", () => {
    expect(formatFileRef("foo`bar.txt")).toBe("@file:``foo\\`bar.txt``");
  });

  it("escapes backslashes in length-2 fence bodies", () => {
    expect(formatFileRef("a\\`b")).toBe("@file:``a\\\\\\`b``");
  });
});

describe("formatFileRef + parser roundtrip", () => {
  const paths = [
    "simple.txt",
    "path/with/dirs.txt",
    "path with spaces.txt",
    "a`b.txt",
    "a``b.txt",
    "a```b.txt",
    "a\\b.txt",
    "a\\`b.txt",
    "C:\\path\\file.txt",
    "/tmp/Screenshot 2024-01-01 at 10.00.00.png",
  ];
  for (const p of paths) {
    it(`roundtrips ${JSON.stringify(p)}`, () => {
      const formatted = formatFileRef(p);
      const regex = new RegExp(AT_FILE_PATTERN.source, "g");
      const match = regex.exec(formatted);
      expect(match).not.toBeNull();
      expect(extractFileRefPath(match!)).toBe(p);
    });
  }
});
