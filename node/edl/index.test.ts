import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RunScriptResult } from "./index.ts";
import { runScript } from "./index.ts";

let testCounter = 0;

async function withTmpDir(fn: (tmpDir: string) => Promise<void>) {
  const tmpDir = path.join(
    "/tmp/magenta-test",
    `runscript-${Date.now()}-${testCounter++}`,
  );
  await fs.mkdir(tmpDir, { recursive: true });
  try {
    await fn(tmpDir);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function normalizePaths(
  result: RunScriptResult,
  tmpDir: string,
): RunScriptResult {
  if (result.status === "ok") {
    return {
      status: "ok",
      data: {
        ...result.data,
        mutations: result.data.mutations.map((m) => ({
          ...m,
          path: m.path.replaceAll(tmpDir, "<tmpDir>"),
        })),
        trace: result.data.trace.map((t) => ({
          ...t,
          command: t.command.replaceAll(tmpDir, "<tmpDir>"),
          snippet: t.snippet.replaceAll(tmpDir, "<tmpDir>"),
        })),
        fileErrors: result.data.fileErrors.map((fe) => ({
          ...fe,
          path: fe.path.replaceAll(tmpDir, "<tmpDir>"),
          trace: fe.trace.map((t) => ({
            ...t,
            command: t.command.replaceAll(tmpDir, "<tmpDir>"),
            snippet: t.snippet.replaceAll(tmpDir, "<tmpDir>"),
          })),
        })),
      },
      formatted: result.formatted.replaceAll(tmpDir, "<tmpDir>"),
      edlRegisters: result.edlRegisters,
    };
  }
  return {
    status: "error",
    error: result.error.replaceAll(tmpDir, "<tmpDir>"),
  };
}

describe("runScript", () => {
  it("returns ok with trace, mutations, and final selection", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const result = await runScript(`\
file \`${filePath}\`
narrow /world/
retain_first
replace <<END
planet
END`);

      expect(normalizePaths(result, tmpDir)).toMatchSnapshot();
    });
  });

  it("returns error with message and trace on execution failure", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const result = await runScript(`\
file \`${filePath}\`
narrow /hello/
retain_first
narrow /nonexistent/`);

      expect(normalizePaths(result, tmpDir)).toMatchSnapshot();
    });
  });

  it("returns error on parse failure", async () => {
    const result = await runScript("invalidcommand blah");

    expect(result).toMatchSnapshot();
  });

  it("returns ok with no mutations when script only selects", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const result = await runScript(`\
file \`${filePath}\`
narrow /hello/
retain_first`);

      expect(normalizePaths(result, tmpDir)).toMatchSnapshot();
    });
  });

  it("returns error when empty heredoc is used as select pattern", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world\n", "utf-8");

      const result = await runScript(`\
file \`${filePath}\`
select_one <<FIND
FIND`);

      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.data.fileErrors.length).toBe(1);
      expect(result.data.fileErrors[0].error).toContain(
        "Empty literal pattern",
      );
    });
  });
});

describe("register persistence across invocations", () => {
  it("registers from one runScript call can be pre-loaded into the next", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "aaa bbb ccc", "utf-8");

      const result1 = await runScript(`\
file \`${filePath}\`
select_one /bbb/
cut myReg`);

      expect(result1.status).toBe("ok");
      if (result1.status !== "ok") return;
      expect(result1.edlRegisters.registers.get("myReg")).toBe("bbb");

      await fs.writeFile(filePath, "aaa  ccc", "utf-8");

      const result2 = await runScript(
        `\
file \`${filePath}\`
select_one /  /
replace myReg`,
        undefined,
        result1.edlRegisters,
      );

      expect(result2.status).toBe("ok");
      if (result2.status !== "ok") return;
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("aaabbbccc");
    });
  });

  it("round-trip: fail saves register, next script replaces from it", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world", "utf-8");

      const result1 = await runScript(`\
file \`${filePath}\`
select_one /nonexistent/
replace <<END
replacement text here
END`);

      expect(result1.status).toBe("ok");
      if (result1.status !== "ok") return;
      expect(result1.data.fileErrors.length).toBe(1);
      expect(result1.edlRegisters.registers.get("_saved_1")).toBe(
        "replacement text here",
      );
      expect(result1.edlRegisters.nextSavedId).toBe(1);

      const result2 = await runScript(
        `\
file \`${filePath}\`
select_one /world/
replace _saved_1`,
        undefined,
        result1.edlRegisters,
      );

      expect(result2.status).toBe("ok");
      if (result2.status !== "ok") return;
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe("hello replacement text here");
    });
  });

  it("cut in one invocation can be used via insert_after in a subsequent invocation", async () => {
    await withTmpDir(async (tmpDir) => {
      const file1 = path.join(tmpDir, "a.txt");
      const file2 = path.join(tmpDir, "b.txt");
      await fs.writeFile(file1, "foo bar baz", "utf-8");
      await fs.writeFile(file2, "start end", "utf-8");

      const result1 = await runScript(`\
file \`${file1}\`
select_one / bar/
cut chunk`);

      expect(result1.status).toBe("ok");
      if (result1.status !== "ok") return;
      expect(result1.edlRegisters.registers.get("chunk")).toBe(" bar");

      const result2 = await runScript(
        `\
file \`${file2}\`
select_one /start/
insert_after chunk`,
        undefined,
        result1.edlRegisters,
      );

      expect(result2.status).toBe("ok");
      if (result2.status !== "ok") return;
      const content = await fs.readFile(file2, "utf-8");
      expect(content).toBe("start bar end");
    });
  });

  it("saved register counter continues across invocations", async () => {
    await withTmpDir(async (tmpDir) => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.writeFile(filePath, "hello world", "utf-8");

      const result1 = await runScript(`\
file \`${filePath}\`
select_one /nonexistent/
replace <<END
text1
END`);

      expect(result1.status).toBe("ok");
      if (result1.status !== "ok") return;
      expect(result1.edlRegisters.nextSavedId).toBe(1);
      expect(result1.edlRegisters.registers.has("_saved_1")).toBe(true);

      await fs.writeFile(filePath, "hello world", "utf-8");

      const result2 = await runScript(
        `\
file \`${filePath}\`
select_one /alsoNonexistent/
replace <<END
text2
END`,
        undefined,
        result1.edlRegisters,
      );

      expect(result2.status).toBe("ok");
      if (result2.status !== "ok") return;
      expect(result2.edlRegisters.nextSavedId).toBe(2);
      expect(result2.edlRegisters.registers.get("_saved_2")).toBe("text2");
      expect(result2.edlRegisters.registers.get("_saved_1")).toBe("text1");
    });
  });
});
