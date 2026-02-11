import { describe, expect, it } from "vitest";
import { parse } from "./parser.ts";

describe("edl parser", () => {
  it("parses narrow with regex", () => {
    const cmds = parse(`narrow /hello/`);
    expect(cmds).toEqual([
      {
        type: "narrow",
        pattern: { type: "regex", pattern: /hello/g },
      },
    ]);
  });

  it("parses narrow with line number", () => {
    const cmds = parse(`narrow 55`);
    expect(cmds).toEqual([
      { type: "narrow", pattern: { type: "line", line: 55 } },
    ]);
  });

  it("parses narrow with line:col", () => {
    const cmds = parse(`narrow 55:10`);
    expect(cmds).toEqual([
      { type: "narrow", pattern: { type: "lineCol", line: 55, col: 10 } },
    ]);
  });

  it("parses narrow with heredoc literal", () => {
    const cmds = parse(`narrow <<FIND
exact text
FIND`);
    expect(cmds).toEqual([
      {
        type: "narrow",
        pattern: { type: "literal", text: "exact text" },
      },
    ]);
  });

  it("parses bof and eof", () => {
    const cmds = parse(`narrow bof\nnarrow eof`);
    expect(cmds).toEqual([
      { type: "narrow", pattern: { type: "bof" } },
      { type: "narrow", pattern: { type: "eof" } },
    ]);
  });

  it("parses replace with heredoc", () => {
    const cmds = parse(`replace <<END
new text
END`);
    expect(cmds).toEqual([{ type: "replace", text: "new text" }]);
  });

  it("parses delete", () => {
    expect(parse(`delete`)).toEqual([{ type: "delete" }]);
  });

  it("parses insert_before and insert_after", () => {
    const cmds = parse(`insert_before <<END
before
END
insert_after <<END
after
END`);
    expect(cmds).toEqual([
      { type: "insert_before", text: "before" },
      { type: "insert_after", text: "after" },
    ]);
  });

  it("parses cut", () => {
    const cmds = parse(`cut my_reg`);
    expect(cmds).toEqual([{ type: "cut", register: "my_reg" }]);
  });

  it("parses file command", () => {
    const cmds = parse(`file src/app.ts`);
    expect(cmds).toEqual([{ type: "file", path: "src/app.ts" }]);
  });

  it("parses retain_nth", () => {
    const cmds = parse(`retain_nth 2`);
    expect(cmds).toEqual([{ type: "retain_nth", n: 2 }]);
  });

  it("parses retain_first and retain_last", () => {
    const cmds = parse(`retain_first\nretain_last`);
    expect(cmds).toEqual([{ type: "retain_first" }, { type: "retain_last" }]);
  });

  it("skips comments and blank lines", () => {
    const cmds = parse(`# comment\n\ndelete\n# another`);
    expect(cmds).toEqual([{ type: "delete" }]);
  });

  it("errors on unknown command", () => {
    expect(() => parse(`bogus`)).toThrow("Unknown command");
  });

  it("errors on unterminated heredoc", () => {
    expect(() => parse(`replace <<END\nsome text`)).toThrow(
      "Unterminated heredoc",
    );
  });

  it("parses regex with escaped slash", () => {
    const cmds = parse(`narrow /foo\\/bar/`);
    expect(cmds).toEqual([
      { type: "narrow", pattern: { type: "regex", pattern: /foo\/bar/g } },
    ]);
  });

  it("parses regex with special characters", () => {
    const cmds = parse(`narrow /\\d+\\.\\d+/`);
    expect(cmds).toEqual([
      { type: "narrow", pattern: { type: "regex", pattern: /\d+\.\d+/g } },
    ]);
  });

  it("parses regex with flags", () => {
    const cmds = parse(`narrow /hello/i`);
    expect(cmds).toEqual([
      { type: "narrow", pattern: { type: "regex", pattern: /hello/gi } },
    ]);
  });

  it("parses regex with escaped newline followed by another command", () => {
    const cmds = parse(`narrow /abc\\ndef/\nnarrow /somethingelse/`);
    expect(cmds).toEqual([
      { type: "narrow", pattern: { type: "regex", pattern: /abc\ndef/g } },
      {
        type: "narrow",
        pattern: { type: "regex", pattern: /somethingelse/g },
      },
    ]);
  });

  it("parses narrow_one", () => {
    const cmds = parse(`narrow_one /hello/`);
    expect(cmds).toEqual([
      { type: "narrow_one", pattern: { type: "regex", pattern: /hello/g } },
    ]);
  });
  it("parses select", () => {
    const cmds = parse(`select /hello/`);
    expect(cmds).toEqual([
      { type: "select", pattern: { type: "regex", pattern: /hello/g } },
    ]);
  });

  it("parses select_one", () => {
    const cmds = parse(`select_one /hello/`);
    expect(cmds).toEqual([
      { type: "select_one", pattern: { type: "regex", pattern: /hello/g } },
    ]);
  });

  it("parses line range pattern", () => {
    const cmds = parse(`narrow 55-70`);
    expect(cmds).toEqual([
      {
        type: "narrow",
        pattern: {
          type: "range",
          from: { type: "line", line: 55 },
          to: { type: "line", line: 70 },
        },
      },
    ]);
  });

  it("parses lineCol range pattern", () => {
    const cmds = parse(`narrow 13:5-14:7`);
    expect(cmds).toEqual([
      {
        type: "narrow",
        pattern: {
          type: "range",
          from: { type: "lineCol", line: 13, col: 5 },
          to: { type: "lineCol", line: 14, col: 7 },
        },
      },
    ]);
  });

  it("parses bof-eof range pattern", () => {
    const cmds = parse(`narrow bof-eof`);
    expect(cmds).toEqual([
      {
        type: "narrow",
        pattern: {
          type: "range",
          from: { type: "bof" },
          to: { type: "eof" },
        },
      },
    ]);
  });

  it("parses mixed range pattern bof-55", () => {
    const cmds = parse(`select bof-55`);
    expect(cmds).toEqual([
      {
        type: "select",
        pattern: {
          type: "range",
          from: { type: "bof" },
          to: { type: "line", line: 55 },
        },
      },
    ]);
  });

  it("parses range pattern 3-eof", () => {
    const cmds = parse(`select 3-eof`);
    expect(cmds).toEqual([
      {
        type: "select",
        pattern: {
          type: "range",
          from: { type: "line", line: 3 },
          to: { type: "eof" },
        },
      },
    ]);
  });

  it("parses select with single line number", () => {
    const cmds = parse(`select 5`);
    expect(cmds).toEqual([
      { type: "select", pattern: { type: "line", line: 5 } },
    ]);
  });

  it("parses select with bof", () => {
    const cmds = parse(`select bof`);
    expect(cmds).toEqual([{ type: "select", pattern: { type: "bof" } }]);
  });

  it("parses select_one with heredoc", () => {
    const cmds = parse(`select_one <<FIND
some text
FIND`);
    expect(cmds).toEqual([
      { type: "select_one", pattern: { type: "literal", text: "some text" } },
    ]);
  });

  it("parses select with lineCol", () => {
    const cmds = parse(`select 5:10`);
    expect(cmds).toEqual([
      { type: "select", pattern: { type: "lineCol", line: 5, col: 10 } },
    ]);
  });

  it("parses lineCol-lineCol range pattern", () => {
    const cmds = parse(`select 1:0-3:5`);
    expect(cmds).toEqual([
      {
        type: "select",
        pattern: {
          type: "range",
          from: { type: "lineCol", line: 1, col: 0 },
          to: { type: "lineCol", line: 3, col: 5 },
        },
      },
    ]);
  });
  it("parses heredoc with single-quoted delimiter", () => {
    const cmds = parse(`select_one <<'END'
some text
END`);
    expect(cmds).toEqual([
      { type: "select_one", pattern: { type: "literal", text: "some text" } },
    ]);
  });

  it("parses replace with single-quoted heredoc delimiter", () => {
    const cmds = parse(`replace <<'DELIM'
new text
DELIM`);
    expect(cmds).toEqual([{ type: "replace", text: "new text" }]);
  });

  it("errors on unterminated single-quoted heredoc marker", () => {
    expect(() => parse(`replace <<'END\nsome text\nEND`)).toThrow(
      "Unterminated quoted heredoc marker",
    );
  });

  it("errors on empty single-quoted heredoc marker", () => {
    expect(() => parse(`replace <<''\nsome text`)).toThrow(
      "Invalid heredoc marker",
    );
  });
  it("suggests unique delimiter when heredoc terminator conflicts with content", () => {
    const script = `select_one <<END
some text
END
more content with END on its own line
END`;
    expect(() => parse(script)).toThrow("Use a unique termination code");
  });

  it("does not add delimiter hint when there is no conflict", () => {
    expect(() => parse(`replace <<END\nsome text`)).toThrow(
      "Unterminated heredoc",
    );
    expect(() => parse(`replace <<END\nsome text`)).not.toThrow(
      "unique termination code",
    );
  });

  it("includes conflicting delimiter name in error message", () => {
    const script = `replace <<END
END
extra stuff
END`;
    expect(() => parse(script)).toThrow('"END"');
  });
});
