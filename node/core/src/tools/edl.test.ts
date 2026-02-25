import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as Edl from "./edl.ts";
import { FsFileIO } from "../capabilities/file-io.ts";
import type { ToolRequestId } from "../tool-types.ts";
import type { NvimCwd, HomeDir } from "../utils/files.ts";
import type { OnToolApplied } from "../capabilities/context-tracker.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";
import type { EdlRegisters } from "../index.ts";

describe("EdlTool unit tests", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edl-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("edl edit dispatches context manager update", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "hello world\n", "utf-8");

    const onToolApplied = vi.fn<OnToolApplied>();
    const edlRegisters: EdlRegisters = {
      registers: new Map(),
      nextSavedId: 1,
    };

    const script = `file \`${filePath}\`
narrow /hello/
replace <<END
goodbye
END`;

    const input: Edl.Input = { script };
    const invocation = Edl.execute(
      {
        id: "tool_1" as ToolRequestId,
        toolName: "edl",
        input,
      },
      {
        cwd: tmpDir as NvimCwd,
        homeDir: "/tmp/fake-home" as HomeDir,
        fileIO: new FsFileIO(),
        edlRegisters,
        onToolApplied,
      },
    );

    const result = await invocation.promise;

    expect(result.result.status).toBe("ok");

    expect(onToolApplied).toHaveBeenCalledWith(
      expect.stringContaining("test.txt"),
      expect.objectContaining({
        type: "edl-edit",
        content: "goodbye world\n",
      }),
      expect.objectContaining({
        category: "text",
      }),
    );

    const fileContent = await fs.readFile(filePath, "utf-8");
    expect(fileContent).toBe("goodbye world\n");
  });

  function createTool(script: string, opts?: { registers?: EdlRegisters }) {
    const onToolApplied = vi.fn<OnToolApplied>();
    const edlRegisters: EdlRegisters = opts?.registers ?? {
      registers: new Map(),
      nextSavedId: 1,
    };

    const invocation = Edl.execute(
      {
        id: "tool_1" as ToolRequestId,
        toolName: "edl",
        input: { script },
      },
      {
        cwd: tmpDir as NvimCwd,
        homeDir: "/tmp/fake-home" as HomeDir,
        fileIO: new FsFileIO(),
        edlRegisters,
        onToolApplied,
      },
    );

    return { invocation, onToolApplied, edlRegisters };
  }

  async function getResultText(invocation: {
    promise: Promise<ProviderToolResult>;
  }): Promise<{ status: string; text: string }> {
    const result = await invocation.promise;
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      return { status: "ok", text };
    }
    return { status: "error", text: result.result.error };
  }

  it("successful script returns mutation summary", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "hello world\n", "utf-8");

    const script = `file \`${filePath}\`
narrow /hello/
replace <<END
goodbye
END`;

    const { invocation } = createTool(script);
    const { status, text } = await getResultText(invocation);

    expect(status).toBe("ok");
    expect(text).toContain('"replacements":1');
    expect(text).toContain('"fileErrorCount":0');

    const fileContent = await fs.readFile(filePath, "utf-8");
    expect(fileContent).toBe("goodbye world\n");
  });

  it("parse error returns error result", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "hello\n", "utf-8");

    const script = `file \`${filePath}\`
invalid_command`;

    const { invocation } = createTool(script);
    const { status, text } = await getResultText(invocation);

    expect(status).toBe("error");
    expect(text).toContain("Parse error");
  });

  it("execution error for non-matching pattern returns error info", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await fs.writeFile(filePath, "hello world\n", "utf-8");

    const script = `file \`${filePath}\`
narrow /nonexistent pattern that does not exist/`;

    const { invocation } = createTool(script);
    const { status, text } = await getResultText(invocation);

    expect(status).toBe("ok");
    expect(text).toContain('"fileErrorCount":1');
  });
});
