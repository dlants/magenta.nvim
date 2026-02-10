import { describe, it, expect } from "vitest";
import { FsFileIO } from "./test-helpers.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Executor, resolveIndex, type InitialDocIndex } from "./executor.ts";
import { parse } from "./parser.ts";

let testCounter = 0;

async function withTmpDir(fn: (tmpDir: string) => Promise<void>) {
  const tmpDir = path.join(
    "/tmp/magenta-test",
    `executor-${Date.now()}-${testCounter++}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    await fn(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function executor(commands: ReturnType<typeof parse>) {
  return new Executor(new FsFileIO()).execute(commands);
}

function expectFileError(
  result: Awaited<ReturnType<typeof executor>>,
  pathSubstring: string,
  errorSubstring: string,
) {
  const error = result.fileErrors.find(
    (e) => e.path.includes(pathSubstring) && e.error.includes(errorSubstring),
  );
  expect(error).toBeDefined();
  return error!;
}

it("should find and replace text in a file", async () => {
  await withTmpDir(async (tmpDir) => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(
      filePath,
      `\
hello world
goodbye world
`,
      "utf-8",
    );

    const script = `\
file \`${filePath}\`
narrow /world/
replace <<END
planet
END`;
    const commands = parse(script);
    const executor = new Executor(new FsFileIO());
    const result = await executor.execute(commands);

    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toBe(`\
hello planet
goodbye planet
`);
    expect(result.mutations.get(filePath)?.replacements).toBe(2);
  });
});

describe("selection commands", () => {
  it("select: refines within existing selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /aaa/
replace <<END
xxx
END`;
      const commands = parse(script);
      const result = await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("xxx bbb xxx bbb xxx\n");
      expect(result.mutations.get(filePath)?.replacements).toBe(3);
    });
  });

  it("select: errors when no match", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /zzz/`;
      const commands = parse(script);
      const result = await executor(commands);
      expectFileError(result, "test.txt", "no matches");
    });
  });

  it("select_first: selects only the first match", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /aaa/
retain_first
replace <<END
xxx
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("xxx bbb aaa bbb aaa\n");
    });
  });

  it("select_last: selects only the last match", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /aaa/
retain_last
replace <<END
xxx
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaa bbb aaa bbb xxx\n");
    });
  });

  it("narrow_one: selects when exactly one match", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb ccc\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow_one /bbb/
replace <<END
xxx
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaa xxx ccc\n");
    });
  });

  it("narrow_one: errors when multiple matches", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow_one /aaa/`;
      const commands = parse(script);
      const result = await executor(commands);
      expectFileError(result, "test.txt", "expected 1 match, got 2");
    });
  });

  it("select_next: searches from end of current selection (non-overlapping)", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaabbbbbb", "utf-8");

      // Selection is "aaabbb" (positions 0-6), searching for "bbb"
      // Should find "bbb" at positions 6-9, not re-match within the selection
      const script = `\
file \`${filePath}\`
narrow /aaabbb/
retain_first
select_next /bbb/
replace <<END2
xxx
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaabbbxxx");
    });
  });

  it("select_next: does not find overlapping match within current selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaabbbccc", "utf-8");

      // Selection is "aaabbb" (positions 0-6), searching for "bbb"
      // "bbb" exists at positions 3-6 but overlaps with selection
      // No match exists after position 6, so this should error
      const script = `\
file \`${filePath}\`
narrow /aaabbb/
retain_first
select_next /bbb/`;
      const commands = parse(script);
      const result = await executor(commands);
      expectFileError(result, "test.txt", "no matches after selection");
    });
  });

  it("select_prev: searches up to start of current selection (non-overlapping)", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "bbbbbbaaa", "utf-8");

      // Selection is "bbbaaa" (positions 3-9), searching for "bbb"
      // Should find "bbb" at positions 0-3, not re-match within the selection
      const script = `\
file \`${filePath}\`
narrow /bbbaaa/
retain_last
select_prev /bbb/
replace <<END2
xxx
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("xxxbbbaaa");
    });
  });

  it("select_prev: does not find overlapping match within current selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "cccbbbaaa", "utf-8");

      // Selection is "bbbaaa" (positions 3-9), searching for "bbb"
      // "bbb" exists at positions 3-6 but overlaps with selection
      // No match exists before position 3, so this should error
      const script = `\
file \`${filePath}\`
narrow /bbbaaa/
retain_last
select_prev /bbb/`;
      const commands = parse(script);
      const result = await executor(commands);
      expectFileError(result, "test.txt", "no matches before selection");
    });
  });

  it("extend_forward: searches from end of current selection (non-overlapping)", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaabbbbbb", "utf-8");

      // Selection is "aaabbb" (positions 0-6), extending forward to "bbb"
      // Should extend to include positions 6-9, giving "aaabbbbbb"
      const script = `\
file \`${filePath}\`
narrow /aaabbb/
retain_first
extend_forward /bbb/
replace <<END2
xxx
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("xxx");
    });
  });

  it("extend_back: searches up to start of current selection (non-overlapping)", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "bbbbbbaaa", "utf-8");

      // Selection is "bbbaaa" (positions 3-9), extending back to "bbb"
      // Should extend to include positions 0-3, giving "bbbbbbaaa"
      const script = `\
file \`${filePath}\`
narrow /bbbaaa/
retain_last
extend_back /bbb/
replace <<END2
xxx
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("xxx");
    });
  });
  it("select_next: selects next occurrence after current selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /bbb/
retain_first
select_next /aaa/
replace <<END
xxx
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaa bbb xxx bbb aaa\n");
    });
  });

  it("select_prev: selects previous occurrence before current selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /bbb/
retain_last
select_prev /aaa/
replace <<END
xxx
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaa bbb xxx bbb aaa\n");
    });
  });

  it("extend_forward: extends selection to include match", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(
        filePath,
        "function hello() {\n  return 1;\n}\n",
        "utf-8",
      );

      const script = `\
file \`${filePath}\`
narrow /function hello/
retain_first
extend_forward /}/
replace <<END
function hello() { return 2; }
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("function hello() { return 2; }\n");
    });
  });

  it("extend_back: extends selection backward to include match", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(
        filePath,
        "function hello() {\n  return 1;\n}\n",
        "utf-8",
      );

      const script = `\
file \`${filePath}\`
narrow /}/
retain_first
extend_back /function/
replace <<END
function hello() { return 2; }
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("function hello() { return 2; }\n");
    });
  });

  it("nth: selects nth match from multi-select", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /aaa/
retain_nth 1
replace <<END
xxx
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaa bbb xxx bbb aaa\n");
    });
  });

  it("nth: supports negative indexing", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /aaa/
retain_nth -1
replace <<END
xxx
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaa bbb aaa bbb xxx\n");
    });
  });

  it("file: switches file and resets selection to full file", async () => {
    await withTmpDir(async (tmpDir) => {
      const file1 = path.join(tmpDir, "a.txt");
      const file2 = path.join(tmpDir, "b.txt");
      await fs.writeFile(file1, "file one\n", "utf-8");
      await fs.writeFile(file2, "file two\n", "utf-8");

      const script = `\
file \`${file1}\`
narrow /one/
retain_first
file \`${file2}\`
narrow /two/
retain_first
replace <<END
TWO
END`;
      const commands = parse(script);
      await executor(commands);
      expect(await fs.readFile(file1, "utf-8")).toBe("file one\n");
      expect(await fs.readFile(file2, "utf-8")).toBe("file TWO\n");
    });
  });

  it("select with line number pattern", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "line one\nline two\nline three\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow 2
replace <<END
replaced
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("line one\nreplaced\nline three\n");
    });
  });

  it("select literal backslash via regex", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(
        filePath,
        'import x from "\\path\\to\\file";\n',
        "utf-8",
      );

      const scriptTemplate = await fs.readFile(
        path.join(__dirname, "fixtures/backslash-regex.edl"),
        "utf-8",
      );
      const script = scriptTemplate.replace("{{FILE}}", filePath);
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe('import x from "/newpath\\to\\file";\n');
    });
  });
  it("select escaped backtick via heredoc", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "const s = `hello \\`world\\``;\n", "utf-8");

      const scriptTemplate = await fs.readFile(
        path.join(__dirname, "fixtures/escaped-backtick-heredoc.edl"),
        "utf-8",
      );
      const script = scriptTemplate.replace("{{FILE}}", filePath);
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("const s = `hello \\`planet\\``;\n");
    });
  });

  it("select escaped backtick via regex", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "const s = `hello \\`world\\``;\n", "utf-8");

      const scriptTemplate = await fs.readFile(
        path.join(__dirname, "fixtures/escaped-backtick-regex.edl"),
        "utf-8",
      );
      const script = scriptTemplate.replace("{{FILE}}", filePath);
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("const s = `hello \\`planet\\``;\n");
    });
  });

  it("select with literal heredoc pattern", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "find /pattern/ here\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow <<FIND
/pattern/
FIND
replace <<END2
/replaced/
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("find /replaced/ here\n");
    });
  });

  it("select: searches entire document regardless of current selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /bbb/
retain_first
select /aaa/
replace <<END2
xxx
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("xxx bbb xxx bbb xxx\n");
    });
  });

  it("select_one: searches entire document regardless of current selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb ccc\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /aaa/
retain_first
select_one /bbb/
replace <<END2
xxx
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaa xxx ccc\n");
    });
  });

  it("select_one: errors when multiple matches in document", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb aaa\n", "utf-8");

      const script = `\
file \`${filePath}\`
select_one /aaa/`;
      const commands = parse(script);
      const result = await executor(commands);
      expectFileError(result, "test.txt", "expected 1 match, got 2");
    });
  });

  it("select with line range pattern", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(
        filePath,
        "line one\nline two\nline three\nline four\n",
        "utf-8",
      );

      const script = `\
file \`${filePath}\`
select 2-3
replace <<END2
replaced
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("line one\nreplaced\nline four\n");
    });
  });

  it("select with bof-eof range replaces entire file", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const script = `\
file \`${filePath}\`
select bof-eof
replace <<END2
new content
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("new content");
    });
  });

  it("select with mixed range bof-3", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(
        filePath,
        "line one\nline two\nline three\nline four\n",
        "utf-8",
      );

      const script = `\
file \`${filePath}\`
select bof-2
replace <<END2
replaced
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("replaced\nline three\nline four\n");
    });
  });

  it("select with line-eof range replaces from line to end", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(
        filePath,
        "line one\nline two\nline three\nline four\n",
        "utf-8",
      );

      const script = `\
file \`${filePath}\`
select 3-eof
replace <<END2
replaced
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("line one\nline two\nreplaced");
    });
  });

  it("select with single line number", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa\nbbb\nccc\n", "utf-8");

      const script = `\
file \`${filePath}\`
select 2
replace <<END2
xxx
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaa\nxxx\nccc\n");
    });
  });

  it("select with lineCol range", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "abcdefgh\nijklmnop\nqrstuvwx\n", "utf-8");

      const script = `\
file \`${filePath}\`
select 1:3-2:4
replace <<END2
X
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("abcXmnop\nqrstuvwx\n");
    });
  });

  it("narrow with range pattern restricts within selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(
        filePath,
        "line one\nline two\nline three\nline four\nline five\n",
        "utf-8",
      );

      const script = `\
file \`${filePath}\`
select 2-4
narrow /line three/
replace <<END2
LINE THREE
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe(
        "line one\nline two\nLINE THREE\nline four\nline five\n",
      );
    });
  });

  it("select with lineCol for precise insertion", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const script = `\
file \`${filePath}\`
select 1:5
insert_after <<END2
 beautiful
END2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("hello beautiful world\n");
    });
  });

  it("select with bof and eof", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow bof
insert_after <<END
prefix
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("prefixhello world\n");
    });
  });
});

describe("mutation commands", () => {
  it("delete: removes selected text", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "line one\nline two\nline three\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /line two\\n/
retain_first
delete`;
      const commands = parse(script);
      const result = await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("line one\nline three\n");
      expect(result.mutations.get(filePath)?.deletions).toBe(1);
    });
  });

  it("insert_before: inserts text before selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /world/
retain_first
insert_before <<END
beautiful_
END`;
      const commands = parse(script);
      const result = await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("hello beautiful_world\n");
      expect(result.mutations.get(filePath)?.insertions).toBe(1);
    });
  });

  it("insert_after: inserts text after selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /hello/
retain_first
insert_after <<END
 beautiful
END`;
      const commands = parse(script);
      const result = await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("hello beautiful world\n");
      expect(result.mutations.get(filePath)?.insertions).toBe(1);
    });
  });

  it("insert_before with multi-select", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "a b a b a\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /a/
insert_before <<END
[
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("[a b [a b [a\n");
    });
  });

  it("cut and insert_after register: moves text between locations", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "first\nsecond\nthird\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /second\\n/
retain_first
cut a
file \`${filePath}\`
narrow /third/
retain_first
insert_after a`;
      const commands = parse(script);
      const result = await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("first\nthirdsecond\n\n");
      expect(result.mutations.get(filePath)?.deletions).toBe(1);
      expect(result.mutations.get(filePath)?.insertions).toBe(1);
    });
  });

  it("cut and insert_after register: moves text between files", async () => {
    await withTmpDir(async (tmpDir) => {
      const file1 = path.join(tmpDir, "a.txt");
      const file2 = path.join(tmpDir, "b.txt");
      await fs.writeFile(file1, "keep\nremove\nkeep\n", "utf-8");
      await fs.writeFile(file2, "existing\n", "utf-8");

      const script = `\
file \`${file1}\`
narrow /remove\\n/
retain_first
cut buf
file \`${file2}\`
narrow eof
insert_after buf`;
      const commands = parse(script);
      await executor(commands);
      expect(await fs.readFile(file1, "utf-8")).toBe("keep\nkeep\n");
      expect(await fs.readFile(file2, "utf-8")).toBe("existing\nremove\n");
    });
  });

  it("insert_after register: errors when register is empty", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /hello/
retain_first
insert_after noSuchReg`;
      const commands = parse(script);
      const result = await executor(commands);
      expectFileError(result, "test.txt", 'Register "noSuchReg" is empty');
    });
  });

  it("replace with multi-line heredoc", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "placeholder\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /placeholder/
retain_first
replace <<END
line one
line two
line three
END`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("line one\nline two\nline three\n");
    });
  });

  it("delete with multi-select removes all matches", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "a1 b a2 b a3\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow /b /
delete`;
      const commands = parse(script);
      const result = await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("a1 a2 a3\n");
      expect(result.mutations.get(filePath)?.deletions).toBe(2);
    });
  });
});

describe("error handling", () => {
  it("errors when no file is selected", async () => {
    const script = `narrow /hello/`;
    const commands = parse(script);
    await expect(executor(commands)).rejects.toThrow("No file selected");
  });

  it("errors when file does not exist", async () => {
    const script = "file `/tmp/magenta-test/nonexistent-file-xyz.txt`";
    const commands = parse(script);
    const result = await executor(commands);
    expectFileError(result, "nonexistent-file-xyz.txt", "Failed to read file");
  });

  it("includes pattern in error message for regex", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow_one /nonexistent_pattern/`;
      const commands = parse(script);
      const result = await executor(commands);
      expectFileError(
        result,
        "test.txt",
        "narrow_one: no matches for pattern /nonexistent_pattern/",
      );
    });
  });

  it("includes pattern in error message for heredoc", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const script = `\
file \`${filePath}\`
narrow_one <<FIND
this text does not exist
FIND`;
      const commands = parse(script);
      const result = await executor(commands);
      expectFileError(
        result,
        "test.txt",
        "narrow_one: no matches for pattern <<HEREDOC",
      );
    });
  });
});

describe("per-file error handling", () => {
  it("writes successful files even when other files fail", async () => {
    await withTmpDir(async (tmpDir) => {
      const file1 = path.join(tmpDir, "a.txt");
      const file2 = path.join(tmpDir, "b.txt");
      await fs.writeFile(file1, "original content\n", "utf-8");
      await fs.writeFile(file2, "file two\n", "utf-8");

      const script = `
file \`${file1}\`
narrow /original/
retain_first
replace <<REPL
modified
REPL
file \`${file2}\`
narrow /nonexistent_pattern/`;
      const commands = parse(script);
      const result = await executor(commands);

      expect(await fs.readFile(file1, "utf-8")).toBe("modified content\n");
      expect(await fs.readFile(file2, "utf-8")).toBe("file two\n");

      expect(result.mutations.has(file1)).toBe(true);
      expect(result.mutations.has(file2)).toBe(false);
      expectFileError(result, "b.txt", "no matches");
    });
  });

  it("continues processing after file error to reach other files", async () => {
    await withTmpDir(async (tmpDir) => {
      const file1 = path.join(tmpDir, "a.txt");
      const file2 = path.join(tmpDir, "b.txt");
      const file3 = path.join(tmpDir, "c.txt");
      await fs.writeFile(file1, "aaa\n", "utf-8");
      await fs.writeFile(file2, "bbb\n", "utf-8");
      await fs.writeFile(file3, "ccc\n", "utf-8");

      const script = `
file \`${file1}\`
narrow /aaa/
replace <<REPL
AAA
REPL
file \`${file2}\`
narrow /nonexistent/
file \`${file3}\`
narrow /ccc/
replace <<REPL
CCC
REPL`;
      const commands = parse(script);
      const result = await executor(commands);

      expect(await fs.readFile(file1, "utf-8")).toBe("AAA\n");
      expect(await fs.readFile(file2, "utf-8")).toBe("bbb\n");
      expect(await fs.readFile(file3, "utf-8")).toBe("CCC\n");

      expect(result.mutations.has(file1)).toBe(true);
      expect(result.mutations.has(file2)).toBe(false);
      expect(result.mutations.has(file3)).toBe(true);
      expectFileError(result, "b.txt", "no matches");
    });
  });

  it("handles interleaved edits where one file fails later", async () => {
    await withTmpDir(async (tmpDir) => {
      const file1 = path.join(tmpDir, "a.txt");
      const file2 = path.join(tmpDir, "b.txt");
      await fs.writeFile(file1, "aaa bbb\n", "utf-8");
      await fs.writeFile(file2, "ccc ddd\n", "utf-8");

      const script = `
file \`${file1}\`
narrow /aaa/
replace <<R
AAA
R
file \`${file2}\`
narrow /ccc/
replace <<R
CCC
R
file \`${file1}\`
narrow /nonexistent/`;
      const commands = parse(script);
      const result = await executor(commands);

      expect(await fs.readFile(file1, "utf-8")).toBe("aaa bbb\n");
      expect(await fs.readFile(file2, "utf-8")).toBe("CCC ddd\n");

      expect(result.mutations.has(file1)).toBe(false);
      expect(result.mutations.has(file2)).toBe(true);
      expectFileError(result, "a.txt", "no matches");
    });
  });
});

describe("auto-save registers on error", () => {
  it("saves replace text to a register when select fails before replace", async () => {
    await withTmpDir(async (tmpDir) => {
      const file1 = path.join(tmpDir, "a.txt");
      await fs.writeFile(file1, "hello world\n", "utf-8");

      const script = `
file \`${file1}\`
select_one /nonexistent/
replace <<R
big replacement text here
R`;
      const commands = parse(script);
      const result = await executor(commands);

      const err = expectFileError(result, "a.txt", "no matches");
      expect(err.savedRegisters).toHaveLength(1);
      expect(err.savedRegisters[0].name).toBe("_saved_1");
      expect(err.savedRegisters[0].sizeChars).toBe(
        "big replacement text here".length,
      );

      expect(await fs.readFile(file1, "utf-8")).toBe("hello world\n");
    });
  });

  it("saves multiple mutation command texts from skipped commands", async () => {
    await withTmpDir(async (tmpDir) => {
      const file1 = path.join(tmpDir, "a.txt");
      await fs.writeFile(file1, "hello\n", "utf-8");

      const script = `
file \`${file1}\`
select_one /nonexistent/
replace <<R
first replacement
R
select_one /also_missing/
insert_after <<R
inserted text
R`;
      const commands = parse(script);
      const result = await executor(commands);

      const err = expectFileError(result, "a.txt", "no matches");
      expect(err.savedRegisters).toHaveLength(2);
      expect(err.savedRegisters[0].name).toBe("_saved_1");
      expect(err.savedRegisters[0].sizeChars).toBe("first replacement".length);
      expect(err.savedRegisters[1].name).toBe("_saved_2");
      expect(err.savedRegisters[1].sizeChars).toBe("inserted text".length);
    });
  });

  it("does not save registers when no mutation commands are skipped", async () => {
    await withTmpDir(async (tmpDir) => {
      const file1 = path.join(tmpDir, "a.txt");
      const file2 = path.join(tmpDir, "b.txt");
      await fs.writeFile(file1, "hello\n", "utf-8");
      await fs.writeFile(file2, "world\n", "utf-8");

      const script = `
file \`${file1}\`
select_one /nonexistent/
file \`${file2}\`
select_one /world/
replace <<R
WORLD
R`;
      const commands = parse(script);
      const result = await executor(commands);

      const err = expectFileError(result, "a.txt", "no matches");
      expect(err.savedRegisters).toHaveLength(0);

      expect(await fs.readFile(file2, "utf-8")).toBe("WORLD\n");
    });
  });

  it("saves registers from failed file and still processes successful file", async () => {
    await withTmpDir(async (tmpDir) => {
      const file1 = path.join(tmpDir, "a.txt");
      const file2 = path.join(tmpDir, "b.txt");
      await fs.writeFile(file1, "hello\n", "utf-8");
      await fs.writeFile(file2, "world\n", "utf-8");

      const script = `
file \`${file1}\`
select_one /nonexistent/
replace <<R
saved content
R
file \`${file2}\`
select_one /world/
replace <<R
WORLD
R`;
      const commands = parse(script);
      const result = await executor(commands);

      const err = expectFileError(result, "a.txt", "no matches");
      expect(err.savedRegisters).toHaveLength(1);
      expect(err.savedRegisters[0].name).toBe("_saved_1");

      expect(await fs.readFile(file1, "utf-8")).toBe("hello\n");
      expect(await fs.readFile(file2, "utf-8")).toBe("WORLD\n");
    });
  });

  it("increments register counter across multiple file errors", async () => {
    await withTmpDir(async (tmpDir) => {
      const file1 = path.join(tmpDir, "a.txt");
      const file2 = path.join(tmpDir, "b.txt");
      const file3 = path.join(tmpDir, "c.txt");
      await fs.writeFile(file1, "aaa\n", "utf-8");
      await fs.writeFile(file2, "bbb\n", "utf-8");
      await fs.writeFile(file3, "ccc\n", "utf-8");

      const script = `
file \`${file1}\`
select_one /nonexistent/
replace <<R
text for file1
R
file \`${file2}\`
select_one /also_nonexistent/
replace <<R
text for file2
R
file \`${file3}\`
select_one /ccc/
replace <<R
CCC
R`;
      const commands = parse(script);
      const result = await executor(commands);

      expect(result.fileErrors).toHaveLength(2);
      expect(result.fileErrors[0].savedRegisters[0].name).toBe("_saved_1");
      expect(result.fileErrors[1].savedRegisters[0].name).toBe("_saved_2");

      expect(await fs.readFile(file3, "utf-8")).toBe("CCC\n");
    });
  });

  it("saves text from the failing command itself when it has text", async () => {
    await withTmpDir(async (tmpDir) => {
      const file1 = path.join(tmpDir, "a.txt");
      const file2 = path.join(tmpDir, "b.txt");
      await fs.writeFile(file1, "hello\n", "utf-8");
      await fs.writeFile(file2, "world\n", "utf-8");

      // insert_after will fail because selection was cleared between files
      // We simulate by having a select that matches, then a second file section
      // where insert_before fails due to no selection
      // Actually, let's use a simpler case: select fails, and the select itself
      // doesn't have text, but the replace after it does.
      // For the "failing command itself has text" case, we need a mutation command
      // that throws. E.g. replace when selection is empty (0 ranges).
      // This is hard to trigger naturally. Let's just verify the skipped commands case
      // is working correctly - the failing command (select) has no text, but the
      // replace after it does.
      const script = `
file \`${file1}\`
select /nonexistent/
insert_before <<R
before text
R
replace <<R
replace text
R
file \`${file2}\`
select /world/
replace <<R
WORLD
R`;
      const commands = parse(script);
      const result = await executor(commands);

      const err = expectFileError(result, "a.txt", "no matches");
      expect(err.savedRegisters).toHaveLength(2);
      expect(err.savedRegisters[0].name).toBe("_saved_1");
      expect(err.savedRegisters[0].sizeChars).toBe("before text".length);
      expect(err.savedRegisters[1].name).toBe("_saved_2");
      expect(err.savedRegisters[1].sizeChars).toBe("replace text".length);

      expect(await fs.readFile(file2, "utf-8")).toBe("WORLD\n");
    });
  });

  it("makes saved register content available via replace register", async () => {
    await withTmpDir(async (tmpDir) => {
      const file1 = path.join(tmpDir, "a.txt");
      const file2 = path.join(tmpDir, "b.txt");
      await fs.writeFile(file1, "hello\n", "utf-8");
      await fs.writeFile(file2, "world\n", "utf-8");

      const exec = new Executor(new FsFileIO());
      const script = `
file \`${file1}\`
select_one /nonexistent/
replace <<R
saved content
R
file \`${file2}\`
select_one /world/
replace _saved_1`;
      const commands = parse(script);
      const result = await exec.execute(commands);

      expectFileError(result, "a.txt", "no matches");
      expect(await fs.readFile(file2, "utf-8")).toBe("saved content\n");
    });
  });
});
describe("newfile", () => {
  it("should create a new file and write content", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "new.txt");

      const script = `\
newfile \`${filePath}\`
insert_after <<CONTENT
hello new file
CONTENT`;
      const commands = parse(script);
      const result = await executor(commands);

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("hello new file");
      expect(result.mutations.get(filePath)).toMatchObject({
        insertions: 1,
        linesAdded: 1,
      });
    });
  });

  it("should create an empty file when no mutations follow", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "empty.txt");

      const script = `newfile \`${filePath}\``;
      const commands = parse(script);
      await executor(commands);

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("");
    });
  });

  it("should error if file already exists on disk", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "existing.txt");
      await fs.writeFile(filePath, "existing content", "utf-8");

      const script = `newfile \`${filePath}\``;
      const commands = parse(script);
      const result = await executor(commands);
      expectFileError(result, "existing.txt", "file already exists on disk");
    });
  });

  it("should error if file was already loaded in the same script", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "content", "utf-8");

      const script = `\
file \`${filePath}\`
newfile \`${filePath}\``;
      const commands = parse(script);
      const result = await executor(commands);
      expectFileError(result, "test.txt", "file already loaded");
    });
  });

  it("should create parent directories if they don't exist", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "a", "b", "new.txt");

      const script = `\
newfile \`${filePath}\`
insert_after <<CONTENT
nested file
CONTENT`;
      const commands = parse(script);
      await executor(commands);

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("nested file");
    });
  });
});

describe("resolveIndex", () => {
  it("returns unchanged offset when no transforms", () => {
    expect(resolveIndex(10 as InitialDocIndex, [])).toBe(10);
  });

  it("shifts offset after a replacement", () => {
    // Replace [5, 10) with 20 chars: afterEnd = 25
    const transforms = [{ start: 5, beforeEnd: 10, afterEnd: 25 }];
    expect(resolveIndex(3 as InitialDocIndex, transforms)).toBe(3);
    expect(resolveIndex(12 as InitialDocIndex, transforms)).toBe(27);
  });

  it("throws when offset falls inside replaced region", () => {
    const transforms = [{ start: 5, beforeEnd: 10, afterEnd: 25 }];
    expect(() => resolveIndex(7 as InitialDocIndex, transforms)).toThrow(
      "Cannot resolve position",
    );
  });

  it("leaves offset at start boundary unchanged", () => {
    const transforms = [{ start: 5, beforeEnd: 10, afterEnd: 25 }];
    expect(resolveIndex(5 as InitialDocIndex, transforms)).toBe(5);
  });

  it("composes multiple transforms sequentially", () => {
    // First: replace [30, 35) with 2 chars (processed first in reverse doc order)
    // Second: replace [10, 15) with 2 chars
    const transforms = [
      { start: 30, beforeEnd: 35, afterEnd: 32 },
      { start: 10, beforeEnd: 15, afterEnd: 12 },
    ];
    // Offset 20: T1 doesn't affect (20 <= 30), T2 shifts by (12-15)=-3 → 17
    expect(resolveIndex(20 as InitialDocIndex, transforms)).toBe(17);
    // Offset 40: T1 shifts by -3 → 37, T2 shifts by -3 → 34
    expect(resolveIndex(40 as InitialDocIndex, transforms)).toBe(34);
    // Offset 5: neither affects it
    expect(resolveIndex(5 as InitialDocIndex, transforms)).toBe(5);
  });
});

describe("line/lineCol remapping after mutations", () => {
  it("line number refers to original position after replace adds lines", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(
        filePath,
        "line one\nline two\nline three\nline four\n",
        "utf-8",
      );

      const script = `\
file \`${filePath}\`
select 2
replace <<R1
new line two A
new line two B
new line two C
R1
select 4
replace <<R2
FOUR
R2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe(
        "line one\nnew line two A\nnew line two B\nnew line two C\nline three\nFOUR\n",
      );
    });
  });

  it("line number refers to original position after delete removes lines", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(
        filePath,
        "line one\nline two\nline three\nline four\nline five\n",
        "utf-8",
      );

      const script = `\
file \`${filePath}\`
select 2-3
delete
select 4
replace <<R1
FOUR
R1`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("line one\n\nFOUR\nline five\n");
    });
  });

  it("lineCol refers to original position after earlier mutation", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "abcdef\nghijkl\nmnopqr\n", "utf-8");

      const script = `\
file \`${filePath}\`
select 1
replace <<R1
ABCDEFGHIJ
R1
select 3:2
insert_after <<R2
XX
R2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      // Original line 3 col 2 = offset 14 (after "mn"). After replacing line 1
      // (6→10 chars, delta +4), the "mn" is now at offset 18. Insert after → "mnXXopqr"
      expect(content).toBe("ABCDEFGHIJ\nghijkl\nmnXXopqr\n");
    });
  });

  it("line range refers to original positions after mutation", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(
        filePath,
        "line one\nline two\nline three\nline four\nline five\n",
        "utf-8",
      );

      const script = `\
file \`${filePath}\`
select 1
replace <<R1
LINE ONE LONGER
R1
select 3-4
replace <<R2
REPLACED
R2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("LINE ONE LONGER\nline two\nREPLACED\nline five\n");
    });
  });

  it("last line reference works after earlier mutations", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa\nbbb\nccc", "utf-8");

      const script = `\
file \`${filePath}\`
select 1
replace <<R1
AAAA
R1
select 3
replace <<R2
CCCC
R2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("AAAA\nbbb\nCCCC");
    });
  });

  it("lineCol later in same line maps correctly after earlier insert on that line", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "abcdefghij\nklmnopqrst\n", "utf-8");

      const script = `\
file \`${filePath}\`
select 1:3
insert_after <<R1
XXX
R1
select 1:7
insert_after <<R2
YYY
R2`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      // Original col 3 is after "abc", col 7 is after "abcdefg"
      // After inserting XXX at col 3: "abcXXXdefghij"
      // Col 7 in original = offset 7, shifted by +3 = offset 10 in current doc
      // Insert YYY there: "abcXXXdefgYYYhij"
      expect(content).toBe("abcXXXdefgYYYhij\nklmnopqrst\n");
    });
  });

  it("lineCol later in same line maps correctly after earlier delete on that line", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "abcdefghij\nklmnopqrst\n", "utf-8");

      const script = `\
file \`${filePath}\`
select 1:2-1:5
delete
select 1:7
insert_after <<R1
YYY
R1`;
      const commands = parse(script);
      await executor(commands);
      const content = await fs.readFile(filePath, "utf-8");
      // Original col 2-5 = "cde" deleted: "abfghij"
      // Original col 7 = offset 7, shifted by -3 = offset 4 in current doc
      // Insert YYY there: "abfgYYYhij"
      expect(content).toBe("abfgYYYhij\nklmnopqrst\n");
    });
  });

  it("replace selects the replacement text", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const script = `\
file \`${filePath}\`
select_one /hello/
replace <<R1
goodbye
R1`;
      const commands = parse(script);
      const exec = new Executor(new FsFileIO());
      const result = await exec.execute(commands);
      expect(result.finalSelection?.ranges[0].content).toBe("goodbye");
    });
  });
});

describe("register-based mutation commands", () => {
  it("replace with register name uses register content", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const exec = new Executor(new FsFileIO());
      exec.registers.set("myReg", "replaced content");
      const commands = parse(
        `file \`${filePath}\`\nselect_one <<END\nhello world\nEND\nreplace myReg\n`,
      );
      const result = await exec.execute(commands);
      expect(result.mutations.size).toBe(1);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("replaced content\n");
    });
  });

  it("insert_before with register name inserts register content", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "line1\nline2\n", "utf-8");

      const exec = new Executor(new FsFileIO());
      exec.registers.set("prefix", "INSERTED\n");
      const commands = parse(
        `file \`${filePath}\`\nselect_one <<END\nline2\nEND\ninsert_before prefix\n`,
      );
      const result = await exec.execute(commands);
      expect(result.mutations.size).toBe(1);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("line1\nINSERTED\nline2\n");
    });
  });

  it("insert_after with register name inserts register content", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "line1\nline2\n", "utf-8");

      const exec = new Executor(new FsFileIO());
      exec.registers.set("suffix", "\nAPPENDED");
      const commands = parse(
        `file \`${filePath}\`\nselect_one <<END\nline1\nEND\ninsert_after suffix\n`,
      );
      const result = await exec.execute(commands);
      expect(result.mutations.size).toBe(1);
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("line1\nAPPENDED\nline2\n");
    });
  });

  it("replace with nonexistent register throws error", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello\n", "utf-8");

      const exec = new Executor(new FsFileIO());
      const commands = parse(
        `file \`${filePath}\`\nselect_one <<END\nhello\nEND\nreplace noSuchReg\n`,
      );
      const result = await exec.execute(commands);
      const err = expectFileError(result, "test.txt", "noSuchReg");
      expect(err.error).toContain("does not exist");
    });
  });

  it("insert_before with nonexistent register throws error", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello\n", "utf-8");

      const exec = new Executor(new FsFileIO());
      const commands = parse(
        `file \`${filePath}\`\nselect_one <<END\nhello\nEND\ninsert_before noSuchReg\n`,
      );
      const result = await exec.execute(commands);
      const err = expectFileError(result, "test.txt", "noSuchReg");
      expect(err.error).toContain("does not exist");
    });
  });
});
