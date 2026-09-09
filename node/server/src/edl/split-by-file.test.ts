import { describe, expect, it } from "vitest";
import { analyzeFileAccess, splitScriptByFile } from "./index.ts";
import { parse } from "./parser.ts";

describe("splitScriptByFile", () => {
  it("splits a complete multi-file script into per-file segments", () => {
    const script = [
      "file `a.ts`",
      "select <<END",
      "file `decoy.ts`",
      "END",
      "replace <<END",
      "new",
      "END",
      "newfile `b.ts`",
      'insert_after "hi"',
      "file `c.ts`",
      "delete",
    ].join("\n");

    const segments = splitScriptByFile(script);
    expect(segments.map((s) => s.path)).toEqual(["a.ts", "b.ts", "c.ts"]);

    expect(segments[0].segment).toContain("file `a.ts`");
    expect(segments[0].segment).toContain("file `decoy.ts`");
    expect(segments[0].segment).not.toContain("newfile `b.ts`");
    expect(segments[1].segment).toContain("newfile `b.ts`");
    expect(segments[2].segment).toContain("file `c.ts`");
    expect(segments[2].segment).toContain("delete");
  });

  it("does not throw on a script truncated mid-heredoc", () => {
    const script = ["file `a.ts`", "replace <<END", "partial content"].join(
      "\n",
    );
    expect(() => splitScriptByFile(script)).not.toThrow();
    const segments = splitScriptByFile(script);
    expect(segments.map((s) => s.path)).toEqual(["a.ts"]);
  });

  it("does not throw on empty or whitespace-only input", () => {
    expect(splitScriptByFile("")).toEqual([]);
    expect(splitScriptByFile("   \n  ")).toEqual([]);
  });

  it("returns the file discovered before a dangling file directive", () => {
    const script = ["file `a.ts`", "delete", "file `unterminated"].join("\n");
    const segments = splitScriptByFile(script);
    expect(segments.map((s) => s.path)).toEqual(["a.ts"]);
  });

  it("leaves parse/analyzeFileAccess strict", () => {
    expect(() => parse("file `a.ts`\nreplace <<END\noops")).toThrow();
    expect(() => analyzeFileAccess("replace <<END\noops")).toThrow();
  });
});
