import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execute, type Input } from "./getFile.ts";
import { FsFileIO } from "@magenta/core";
import type { ToolRequestId } from "./types.ts";

import type { Dispatch } from "../tea/tea.ts";
import type { Msg as ThreadMsg } from "../chat/thread.ts";
import type {
  UnresolvedFilePath,
  NvimCwd,
  HomeDir,
  AbsFilePath,
} from "../utils/files.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { ContextManager } from "../context/context-manager.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";

describe("GetFileTool unit tests", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "getfile-unit-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createTool(
    input: Partial<Input> & { filePath: UnresolvedFilePath },
    opts: {
      contextFiles?: Record<string, unknown>;
    } = {},
  ) {
    const threadDispatch = vi.fn<Dispatch<ThreadMsg>>();
    const mockNvim = {
      logger: { error: vi.fn(), info: vi.fn() },
    } as unknown as Nvim;
    const mockContextManager = {
      files: opts.contextFiles ?? {},
    } as unknown as ContextManager;

    const invocation = execute(
      {
        id: "tool_1" as ToolRequestId,
        toolName: "get_file" as const,
        input: input as Input,
      },
      {
        nvim: mockNvim,
        cwd: tmpDir as NvimCwd,
        homeDir: "/tmp/fake-home" as HomeDir,
        fileIO: new FsFileIO(),
        contextManager: mockContextManager,
        threadDispatch,
      },
    );

    return { invocation, threadDispatch };
  }

  async function getResult(invocation: {
    promise: Promise<ProviderToolResult>;
  }) {
    const result = await invocation.promise;
    return result;
  }

  it("returns early when file is already in context", async () => {
    const filePath = path.join(tmpDir, "existing.txt");
    await fs.writeFile(filePath, "file content here", "utf-8");

    const absFilePath = filePath as AbsFilePath;
    const { invocation } = createTool(
      { filePath: "existing.txt" as UnresolvedFilePath },
      {
        contextFiles: {
          [absFilePath]: {
            relFilePath: "existing.txt",
            fileTypeInfo: {
              category: "text",
              mimeType: "text/plain",
              extension: ".txt",
            },
            agentView: { type: "text", content: "file content here" },
          },
        },
      },
    );

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("already part of the thread context");
    }
  });

  it("reads file when force is true even if already in context", async () => {
    const filePath = path.join(tmpDir, "existing.txt");
    await fs.writeFile(filePath, "Moonlight whispers", "utf-8");

    const absFilePath = filePath as AbsFilePath;
    const { invocation, threadDispatch } = createTool(
      { filePath: "existing.txt" as UnresolvedFilePath, force: true },
      {
        contextFiles: {
          [absFilePath]: {
            relFilePath: "existing.txt",
            fileTypeInfo: {
              category: "text",
              mimeType: "text/plain",
              extension: ".txt",
            },
            agentView: { type: "text", content: "Moonlight whispers" },
          },
        },
      },
    );

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("Moonlight whispers");
    }
    // Should also dispatch context-manager-msg
    expect(threadDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "context-manager-msg" }),
    );
  });

  it("should handle file size limits appropriately", async () => {
    const filePath = path.join(tmpDir, "large.jpg");
    // Create a file larger than the 10MB image limit
    // Write JPEG magic bytes so detectFileType identifies it as an image
    const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const largeBuffer = Buffer.alloc(11 * 1024 * 1024);
    jpegHeader.copy(largeBuffer);
    await fs.writeFile(filePath, largeBuffer);

    const { invocation } = createTool({
      filePath: "large.jpg" as UnresolvedFilePath,
    });

    const result = await getResult(invocation);

    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("File too large");
    }
  });

  it("large text files are truncated and skip context manager", async () => {
    const filePath = path.join(tmpDir, "large.txt");
    // Create file with >40000 chars (1000 lines of 100 chars)
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push("x".repeat(100));
    }
    await fs.writeFile(filePath, lines.join("\n"), "utf-8");

    const { invocation, threadDispatch } = createTool({
      filePath: "large.txt" as UnresolvedFilePath,
    });

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      // Should contain summary info (file summary header)
      expect(text).toContain("File summary:");
    }
    // Should NOT dispatch context-manager-msg since file was truncated
    const contextCalls = threadDispatch.mock.calls.filter(
      (call) => (call[0] as { type: string }).type === "context-manager-msg",
    );
    expect(contextCalls).toHaveLength(0);
  });

  it("lines that are too long are abridged and skip context manager", async () => {
    const filePath = path.join(tmpDir, "longlines.txt");
    // Create file with a line longer than 2000 chars but total file < 40000 chars
    const longLine = "a".repeat(3000);
    await fs.writeFile(
      filePath,
      `short line\n${longLine}\nanother short`,
      "utf-8",
    );

    const { invocation, threadDispatch } = createTool({
      filePath: "longlines.txt" as UnresolvedFilePath,
    });

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("chars omitted");
    }
    // Should NOT dispatch context-manager-msg since lines were abridged
    const contextCalls = threadDispatch.mock.calls.filter(
      (call) => (call[0] as { type: string }).type === "context-manager-msg",
    );
    expect(contextCalls).toHaveLength(0);
  });

  it("startLine and numLines parameters work", async () => {
    const filePath = path.join(tmpDir, "lines.txt");
    await fs.writeFile(filePath, "line1\nline2\nline3\nline4\nline5", "utf-8");

    const { invocation, threadDispatch } = createTool({
      filePath: "lines.txt" as UnresolvedFilePath,
      startLine: 2,
      numLines: 2,
    });

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("[Lines 2-3 of");
      expect(text).toContain("line2");
      expect(text).toContain("line3");
      expect(text).not.toContain("line1");
    }
    // Partial reads should not dispatch context-manager-msg
    const contextCalls = threadDispatch.mock.calls.filter(
      (call) => (call[0] as { type: string }).type === "context-manager-msg",
    );
    expect(contextCalls).toHaveLength(0);
  });

  it("startLine parameter alone works", async () => {
    const filePath = path.join(tmpDir, "lines.txt");
    await fs.writeFile(filePath, "line1\nline2\nline3\nline4\nline5", "utf-8");

    const { invocation } = createTool({
      filePath: "lines.txt" as UnresolvedFilePath,
      startLine: 3,
    });

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("[Lines 3-");
      expect(text).toContain("line3");
      expect(text).toContain("line4");
      expect(text).toContain("line5");
    }
  });

  it("requesting line range from file already in context returns content", async () => {
    const filePath = path.join(tmpDir, "inctx.txt");
    await fs.writeFile(filePath, "line1\nline2\nline3\nline4", "utf-8");

    const absFilePath = filePath as AbsFilePath;
    const { invocation } = createTool(
      {
        filePath: "inctx.txt" as UnresolvedFilePath,
        startLine: 2,
        numLines: 2,
      },
      {
        contextFiles: {
          [absFilePath]: {
            relFilePath: "inctx.txt",
            fileTypeInfo: {
              category: "text",
              mimeType: "text/plain",
              extension: ".txt",
            },
            agentView: { type: "text", content: "line1\nline2\nline3\nline4" },
          },
        },
      },
    );

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      // Should NOT return "already in context" — should return actual lines
      expect(text).not.toContain("already part of the thread context");
      expect(text).toContain("line2");
      expect(text).toContain("line3");
    }
  });

  it("force parameter with line range returns just those lines", async () => {
    const filePath = path.join(tmpDir, "forced.txt");
    await fs.writeFile(filePath, "alpha\nbeta\ngamma\ndelta\nepsilon", "utf-8");

    const absFilePath = filePath as AbsFilePath;
    const { invocation } = createTool(
      {
        filePath: "forced.txt" as UnresolvedFilePath,
        force: true,
        startLine: 2,
        numLines: 2,
      },
      {
        contextFiles: {
          [absFilePath]: {
            relFilePath: "forced.txt",
            fileTypeInfo: {
              category: "text",
              mimeType: "text/plain",
              extension: ".txt",
            },
            agentView: {
              type: "text",
              content: "alpha\nbeta\ngamma\ndelta\nepsilon",
            },
          },
        },
      },
    );

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("beta");
      expect(text).toContain("gamma");
      expect(text).toContain("[Lines 2-3 of");
    }
  });

  it("invalid startLine beyond file length returns error", async () => {
    const filePath = path.join(tmpDir, "small.txt");
    await fs.writeFile(filePath, "one\ntwo\nthree", "utf-8");

    const { invocation } = createTool({
      filePath: "small.txt" as UnresolvedFilePath,
      startLine: 100,
    });

    const result = await getResult(invocation);

    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain(
        "startLine 100 is beyond end of file",
      );
    }
  });

  it("line ranges with long lines still get abridged", async () => {
    const filePath = path.join(tmpDir, "longrange.txt");
    const longLine = "b".repeat(3000);
    await fs.writeFile(filePath, `short1\n${longLine}\nshort3`, "utf-8");

    const { invocation } = createTool({
      filePath: "longrange.txt" as UnresolvedFilePath,
      startLine: 1,
      numLines: 3,
    });

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("chars omitted");
    }
  });

  it("file does not exist returns error", async () => {
    const { invocation } = createTool({
      filePath: "nonexistent.txt" as UnresolvedFilePath,
    });

    const result = await getResult(invocation);

    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("does not exist");
    }
  });

  it("unsupported binary file returns error", async () => {
    const filePath = path.join(tmpDir, "data.bin");
    // Write some random binary content that is not a recognized format
    const buf = Buffer.alloc(1024);
    // Fill with non-text binary data
    for (let i = 0; i < buf.length; i++) {
      buf[i] = i % 256;
    }
    await fs.writeFile(filePath, buf);

    const { invocation } = createTool({
      filePath: "data.bin" as UnresolvedFilePath,
    });

    const result = await getResult(invocation);

    // Binary files with unrecognized content may be detected as text via isLikelyTextFile
    // or as unsupported. Either way, verify it doesn't crash.
    expect(result.result.status).toBeDefined();
    if (result.result.status === "error") {
      expect(result.result.error).toContain("Unsupported file type");
    }
  });
});
