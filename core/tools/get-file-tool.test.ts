import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  GetFileTool,
  abbreviateLine,
  processTextContent,
  validateFileSize,
  MAX_FILE_CHARACTERS,
  MAX_LINE_CHARACTERS,
  DEFAULT_LINES_FOR_LARGE_FILE,
  type Msg,
  type GetFileToolContext,
} from "./get-file-tool.ts";
import type { FileIO, FileAccess, FileInfo } from "./environment.ts";
import { FILE_SIZE_LIMITS } from "./environment.ts";
import type { Logger } from "../logger.ts";
import type { AbsFilePath, Cwd, HomeDir, UnresolvedFilePath } from "../utils/files.ts";
import type { ToolRequestId, ToolName, ToolMsg } from "./types.ts";
import type { ToolRequest } from "./specs/get-file.ts";
import { validateInput } from "./specs/get-file.ts";
import type { Result } from "../utils/result.ts";
import { createTool, type CreateToolContext } from "./create-tool.ts";
import { TOOL_SPEC_MAP } from "./toolManager.ts";

function mockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

const TEST_CWD = "/test/project" as Cwd;
const TEST_HOME = "/home/user" as HomeDir;

function mockFileIO(files: Record<string, string> = {}): FileIO {
  return {
    async readFile(path) {
      const content = files[path];
      if (content !== undefined) return { status: "ok", value: content };
      return { status: "error", error: `File not found: ${path}` };
    },
    async writeFile() {
      return { status: "ok", value: undefined };
    },
    async fileExists(path) {
      return { status: "ok", value: path in files };
    },
    async mkdir() {
      return { status: "ok", value: undefined };
    },
    async readDir() {
      return { status: "ok", value: [] };
    },
  };
}

type MockFileAccessConfig = {
  getFileInfo?: (path: AbsFilePath) => Promise<Result<FileInfo>>;
  readBinaryFileBase64?: (path: AbsFilePath) => Promise<Result<string>>;
  extractPDFPage?: (
    path: AbsFilePath,
    page: number,
  ) => Promise<Result<string>>;
  getPDFPageCount?: (path: AbsFilePath) => Promise<Result<number>>;
};

function mockFileAccess(
  config: MockFileAccessConfig = {},
): FileAccess & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    async getFileInfo(path) {
      calls.push({ method: "getFileInfo", args: [path] });
      if (config.getFileInfo) return config.getFileInfo(path);
      return { status: "error", error: "not configured" };
    },
    async readBinaryFileBase64(path) {
      calls.push({ method: "readBinaryFileBase64", args: [path] });
      if (config.readBinaryFileBase64)
        return config.readBinaryFileBase64(path);
      return { status: "error", error: "not configured" };
    },
    async extractPDFPage(path, page) {
      calls.push({ method: "extractPDFPage", args: [path, page] });
      if (config.extractPDFPage) return config.extractPDFPage(path, page);
      return { status: "error", error: "not configured" };
    },
    async getPDFPageCount(path) {
      calls.push({ method: "getPDFPageCount", args: [path] });
      if (config.getPDFPageCount) return config.getPDFPageCount(path);
      return { status: "error", error: "not configured" };
    },
  };
}

function makeRequest(
  input: Partial<ToolRequest["input"]> & { filePath: string },
): ToolRequest {
  return {
    id: "test-tool-1" as ToolRequestId,
    toolName: "get_file" as unknown as ToolName,
    input: { filePath: input.filePath as UnresolvedFilePath, ...input },
  };
}

function waitForDone(tool: GetFileTool): Promise<void> {
  return vi.waitFor(() => {
    expect(tool.isDone()).toBe(true);
  });
}

describe("abbreviateLine", () => {
  it("returns short lines unchanged", () => {
    expect(abbreviateLine("short line", MAX_LINE_CHARACTERS)).toBe(
      "short line",
    );
  });

  it("does not abbreviate lines at exactly MAX_LINE_CHARACTERS", () => {
    const exactLine = "a".repeat(MAX_LINE_CHARACTERS);
    expect(abbreviateLine(exactLine, MAX_LINE_CHARACTERS)).toBe(exactLine);
  });

  it("abbreviates lines exceeding MAX_LINE_CHARACTERS", () => {
    const longLine = "x".repeat(MAX_LINE_CHARACTERS + 200);
    const result = abbreviateLine(longLine, MAX_LINE_CHARACTERS);
    expect(result.length).toBeLessThan(longLine.length);
    expect(result).toContain("chars omitted");
    expect(result.startsWith("x")).toBe(true);
    expect(result.endsWith("x")).toBe(true);
  });
});

describe("processTextContent", () => {
  it("returns all content for small file with isComplete true", () => {
    const lines = ["line 1", "line 2", "line 3"];
    const result = processTextContent(lines, 0, undefined);
    expect(result.isComplete).toBe(true);
    expect(result.hasAbridgedLines).toBe(false);
    expect(result.text).toBe("line 1\nline 2\nline 3");
  });

  it("returns slice with header and footer for startLine/numLines", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const result = processTextContent(lines, 2, 4);
    expect(result.text).toContain("[Lines 3-6 of 10]");
    expect(result.text).toContain("line 3");
    expect(result.text).toContain("line 6");
    expect(result.text).toContain(
      "[4 more lines not shown. Use startLine=7 to continue.]",
    );
    expect(result.isComplete).toBe(false);
  });

  it("returns summaryText for large file when provided", () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => "x".repeat(250) + ` line ${i + 1}`,
    );
    const summaryText = "[File summary: 200 lines, 50000 chars]";
    const result = processTextContent(lines, 0, undefined, summaryText);
    expect(result.text).toBe(summaryText);
    expect(result.isComplete).toBe(false);
  });

  it("returns first DEFAULT_LINES_FOR_LARGE_FILE lines for large file without summaryText", () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => "x".repeat(250) + ` line ${i + 1}`,
    );
    const result = processTextContent(lines, 0, undefined);
    expect(result.text).toContain(
      `[Lines 1-${DEFAULT_LINES_FOR_LARGE_FILE} of 200]`,
    );
    expect(result.text).toContain(
      `[${200 - DEFAULT_LINES_FOR_LARGE_FILE} more lines not shown.`,
    );
    expect(result.isComplete).toBe(false);
  });

  it("sets hasAbridgedLines true for lines exceeding MAX_LINE_CHARACTERS", () => {
    const lines = ["short", "x".repeat(MAX_LINE_CHARACTERS + 100), "short2"];
    const result = processTextContent(lines, 0, undefined);
    expect(result.hasAbridgedLines).toBe(true);
    expect(result.isComplete).toBe(false);
    expect(result.text).toContain("chars omitted");
  });

  it("includes remaining lines count in footer when starting from middle", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`);
    const result = processTextContent(lines, 2, undefined);
    expect(result.text).toContain("[Lines 3-5 of 5]");
    expect(result.isComplete).toBe(false);
  });
});

describe("validateFileSize", () => {
  it("text within 1MB is valid", () => {
    const result = validateFileSize(500_000, "text");
    expect(result.isValid).toBe(true);
    expect(result.maxSize).toBe(FILE_SIZE_LIMITS["text"]);
  });

  it("text over 1MB is invalid", () => {
    const result = validateFileSize(2_000_000, "text");
    expect(result.isValid).toBe(false);
  });

  it("image within 10MB is valid", () => {
    const result = validateFileSize(5_000_000, "image");
    expect(result.isValid).toBe(true);
    expect(result.maxSize).toBe(FILE_SIZE_LIMITS["image"]);
  });

  it("image over 10MB is invalid", () => {
    const result = validateFileSize(11_000_000, "image");
    expect(result.isValid).toBe(false);
  });

  it("pdf within 32MB is valid", () => {
    const result = validateFileSize(20_000_000, "pdf");
    expect(result.isValid).toBe(true);
    expect(result.maxSize).toBe(FILE_SIZE_LIMITS["pdf"]);
  });

  it("pdf over 32MB is invalid", () => {
    const result = validateFileSize(40_000_000, "pdf");
    expect(result.isValid).toBe(false);
  });
});

describe("GetFileTool", () => {
  let dispatched: Msg[];
  let logger: Logger;

  beforeEach(() => {
    dispatched = [];
    logger = mockLogger();
  });

  function createGetFileTool(
    input: Partial<ToolRequest["input"]> & { filePath: string },
    files: Record<string, string> = {},
    fileAccessConfig: MockFileAccessConfig = {},
  ) {
    const request = makeRequest(input);
    const fileIO = mockFileIO(files);
    const fileAccess = mockFileAccess(fileAccessConfig);

    let tool: GetFileTool;
    tool = new GetFileTool(request, {
      fileIO,
      fileAccess,
      logger,
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
      myDispatch: (msg: Msg) => {
        dispatched.push(msg);
        tool.update(msg as unknown as ToolMsg);
      },
    });

    return { tool, fileIO, fileAccess };
  }

  it("reads a small text file successfully", async () => {
    const absPath = "/test/project/test.txt";
    const { tool } = createGetFileTool(
      { filePath: "test.txt" },
      { [absPath]: "line 1\nline 2\nline 3" },
      {
        getFileInfo: async () => ({
          status: "ok",
          value: { size: 100, category: "text", mimeType: "text/plain" },
        }),
      },
    );

    expect(tool.state.state).toBe("processing");
    expect(tool.isDone()).toBe(false);

    await waitForDone(tool);

    expect(dispatched.length).toBe(1);
    expect(dispatched[0].type).toBe("finish");
    expect(dispatched[0].result.status).toBe("ok");

    const result = tool.getToolResult();
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      expect(result.result.value[0].type).toBe("text");
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("line 1");
      expect(text).toContain("line 2");
      expect(text).toContain("line 3");
    }
  });

  it("reads text file with startLine and numLines", async () => {
    const absPath = "/test/project/test.txt";
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    const { tool } = createGetFileTool(
      { filePath: "test.txt", startLine: 3, numLines: 4 },
      { [absPath]: lines.join("\n") },
      {
        getFileInfo: async () => ({
          status: "ok",
          value: { size: 100, category: "text", mimeType: "text/plain" },
        }),
      },
    );

    await waitForDone(tool);

    const result = tool.getToolResult();
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("[Lines 3-6 of 10]");
      expect(text).toContain("line 3");
      expect(text).toContain("line 6");
      expect(text).toContain(
        "[4 more lines not shown. Use startLine=7 to continue.]",
      );
    }
  });

  it("reads text file with startLine only (no numLines)", async () => {
    const absPath = "/test/project/test.txt";
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`);
    const { tool } = createGetFileTool(
      { filePath: "test.txt", startLine: 3 },
      { [absPath]: lines.join("\n") },
      {
        getFileInfo: async () => ({
          status: "ok",
          value: { size: 50, category: "text", mimeType: "text/plain" },
        }),
      },
    );

    await waitForDone(tool);

    const result = tool.getToolResult();
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("[Lines 3-5 of 5]");
      expect(text).toContain("line 3");
      expect(text).toContain("line 4");
      expect(text).toContain("line 5");
    }
  });

  it("returns error when startLine beyond file length", async () => {
    const absPath = "/test/project/test.txt";
    const lines = Array.from({ length: 5 }, (_, i) => `line ${i + 1}`);
    const { tool } = createGetFileTool(
      { filePath: "test.txt", startLine: 10 },
      { [absPath]: lines.join("\n") },
      {
        getFileInfo: async () => ({
          status: "ok",
          value: { size: 50, category: "text", mimeType: "text/plain" },
        }),
      },
    );

    await waitForDone(tool);

    const result = tool.getToolResult();
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain(
        "startLine 10 is beyond end of file",
      );
    }
  });

  it("abridges long lines", async () => {
    const absPath = "/test/project/test.txt";
    const longLine = "x".repeat(MAX_LINE_CHARACTERS + 500);
    const { tool } = createGetFileTool(
      { filePath: "test.txt" },
      { [absPath]: longLine },
      {
        getFileInfo: async () => ({
          status: "ok",
          value: {
            size: longLine.length,
            category: "text",
            mimeType: "text/plain",
          },
        }),
      },
    );

    await waitForDone(tool);

    const result = tool.getToolResult();
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("chars omitted");
    }
  });

  it("returns summary for large text file", async () => {
    const absPath = "/test/project/large.txt";
    const lines = Array.from(
      { length: 200 },
      (_, i) => "x".repeat(250) + ` line ${i + 1}`,
    );
    const content = lines.join("\n");
    const { tool } = createGetFileTool(
      { filePath: "large.txt" },
      { [absPath]: content },
      {
        getFileInfo: async () => ({
          status: "ok",
          value: {
            size: content.length,
            category: "text",
            mimeType: "text/plain",
          },
        }),
      },
    );

    await waitForDone(tool);

    const result = tool.getToolResult();
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("[File summary:");
      expect(text).toContain("key segments");
    }
  });

  it("reads image file successfully", async () => {
    const absPath = "/test/project/photo.jpg";
    const { tool } = createGetFileTool(
      { filePath: "photo.jpg" },
      {},
      {
        getFileInfo: async () => ({
          status: "ok",
          value: {
            size: 50_000,
            category: "image",
            mimeType: "image/jpeg",
          },
        }),
        readBinaryFileBase64: async () => ({
          status: "ok",
          value: "base64imagedata",
        }),
      },
    );

    await waitForDone(tool);

    const result = tool.getToolResult();
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const content = result.result.value[0] as {
        type: "image";
        source: { type: "base64"; media_type: string; data: string };
      };
      expect(content.type).toBe("image");
      expect(content.source.media_type).toBe("image/jpeg");
      expect(content.source.data).toBe("base64imagedata");
    }
  });

  it("returns error for image too large", async () => {
    const { tool } = createGetFileTool(
      { filePath: "huge.png" },
      {},
      {
        getFileInfo: async () => ({
          status: "ok",
          value: {
            size: 11_000_000,
            category: "image",
            mimeType: "image/png",
          },
        }),
      },
    );

    await waitForDone(tool);

    const result = tool.getToolResult();
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("File too large");
    }
  });

  it("reads PDF with pdfPage", async () => {
    const { tool } = createGetFileTool(
      { filePath: "doc.pdf", pdfPage: 2 },
      {},
      {
        getFileInfo: async () => ({
          status: "ok",
          value: {
            size: 500_000,
            category: "pdf",
            mimeType: "application/pdf",
          },
        }),
        extractPDFPage: async () => ({
          status: "ok",
          value: "pdfbase64data",
        }),
      },
    );

    await waitForDone(tool);

    const result = tool.getToolResult();
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const content = result.result.value[0] as {
        type: "document";
        source: { type: "base64"; media_type: string; data: string };
        title: string;
      };
      expect(content.type).toBe("document");
      expect(content.source.data).toBe("pdfbase64data");
      expect(content.title).toContain("Page 2");
    }
  });

  it("reads PDF without pdfPage (summary)", async () => {
    const { tool } = createGetFileTool(
      { filePath: "doc.pdf" },
      {},
      {
        getFileInfo: async () => ({
          status: "ok",
          value: {
            size: 500_000,
            category: "pdf",
            mimeType: "application/pdf",
          },
        }),
        getPDFPageCount: async () => ({
          status: "ok",
          value: 5,
        }),
      },
    );

    await waitForDone(tool);

    const result = tool.getToolResult();
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("Pages: 5");
    }
  });

  it("returns error for invalid PDF page", async () => {
    const { tool } = createGetFileTool(
      { filePath: "doc.pdf", pdfPage: 99 },
      {},
      {
        getFileInfo: async () => ({
          status: "ok",
          value: {
            size: 500_000,
            category: "pdf",
            mimeType: "application/pdf",
          },
        }),
        extractPDFPage: async () => ({
          status: "error",
          error: "Page 99 does not exist in document",
        }),
      },
    );

    await waitForDone(tool);

    const result = tool.getToolResult();
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("Page 99");
    }
  });

  it("returns error for unsupported file type", async () => {
    const { tool } = createGetFileTool(
      { filePath: "archive.zip" },
      {},
      {
        getFileInfo: async () => ({
          status: "ok",
          value: {
            size: 1000,
            category: "unsupported",
            mimeType: "application/zip",
          },
        }),
      },
    );

    await waitForDone(tool);

    const result = tool.getToolResult();
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("Unsupported file type");
    }
  });

  it("returns error when file not found", async () => {
    const { tool } = createGetFileTool(
      { filePath: "missing.txt" },
      {},
      {
        getFileInfo: async () => ({
          status: "error",
          error: "ENOENT: no such file or directory",
        }),
      },
    );

    await waitForDone(tool);

    const result = tool.getToolResult();
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("ENOENT");
    }
  });

  it("returns error when readFile fails", async () => {
    const { tool } = createGetFileTool(
      { filePath: "unreadable.txt" },
      {},
      {
        getFileInfo: async () => ({
          status: "ok",
          value: { size: 100, category: "text", mimeType: "text/plain" },
        }),
      },
    );

    await waitForDone(tool);

    const result = tool.getToolResult();
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("File not found");
    }
  });

  it("can be aborted before completion", async () => {
    const neverResolve = () =>
      new Promise<Result<FileInfo>>(() => {
        // intentionally never resolves
      });

    const request = makeRequest({ filePath: "slow.txt" });
    const fileIO = mockFileIO();
    const fileAccess = mockFileAccess({
      getFileInfo: neverResolve,
    });

    let tool: GetFileTool;
    tool = new GetFileTool(request, {
      fileIO,
      fileAccess,
      logger,
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
      myDispatch: (msg: Msg) => {
        dispatched.push(msg);
        tool.update(msg as unknown as ToolMsg);
      },
    });

    // Wait for getFileInfo to be called
    await vi.waitFor(() => {
      expect(fileAccess.calls.length).toBe(1);
    });

    const result = tool.abort();
    expect(tool.isDone()).toBe(true);
    expect(tool.aborted).toBe(true);
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("aborted");
    }
  });

  it("abort after completion returns original result", async () => {
    const absPath = "/test/project/test.txt";
    const { tool } = createGetFileTool(
      { filePath: "test.txt" },
      { [absPath]: "hello" },
      {
        getFileInfo: async () => ({
          status: "ok",
          value: { size: 5, category: "text", mimeType: "text/plain" },
        }),
      },
    );

    await waitForDone(tool);

    const result = tool.abort();
    expect(result.result.status).toBe("ok");
  });

  it("returns processing result before done", () => {
    const request = makeRequest({ filePath: "test.txt" });
    const fileIO = mockFileIO();
    const fileAccess = mockFileAccess({
      getFileInfo: () =>
        new Promise<Result<FileInfo>>(() => {
          // intentionally never resolves
        }),
    });

    const tool = new GetFileTool(request, {
      fileIO,
      fileAccess,
      logger,
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
      myDispatch: () => {},
    });

    const result = tool.getToolResult();
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("being processed");
    }
  });
});

describe("validateInput", () => {
  it("rejects missing filePath", () => {
    const result = validateInput({});
    expect(result.status).toBe("error");
  });

  it("rejects non-string filePath", () => {
    const result = validateInput({ filePath: 123 });
    expect(result.status).toBe("error");
  });

  it("accepts valid filePath only", () => {
    const result = validateInput({ filePath: "test.txt" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.filePath).toBe("test.txt");
    }
  });

  it("rejects pdfPage 0", () => {
    const result = validateInput({ filePath: "doc.pdf", pdfPage: 0 });
    expect(result.status).toBe("error");
  });

  it("rejects pdfPage -1", () => {
    const result = validateInput({ filePath: "doc.pdf", pdfPage: -1 });
    expect(result.status).toBe("error");
  });

  it("rejects pdfPage 1.5", () => {
    const result = validateInput({ filePath: "doc.pdf", pdfPage: 1.5 });
    expect(result.status).toBe("error");
  });

  it("accepts valid pdfPage", () => {
    const result = validateInput({ filePath: "doc.pdf", pdfPage: 3 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.pdfPage).toBe(3);
    }
  });

  it("rejects startLine 0", () => {
    const result = validateInput({ filePath: "test.txt", startLine: 0 });
    expect(result.status).toBe("error");
  });

  it("rejects startLine -1", () => {
    const result = validateInput({ filePath: "test.txt", startLine: -1 });
    expect(result.status).toBe("error");
  });

  it("accepts valid startLine", () => {
    const result = validateInput({ filePath: "test.txt", startLine: 5 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.startLine).toBe(5);
    }
  });

  it("rejects numLines 0", () => {
    const result = validateInput({ filePath: "test.txt", numLines: 0 });
    expect(result.status).toBe("error");
  });

  it("accepts valid numLines", () => {
    const result = validateInput({ filePath: "test.txt", numLines: 50 });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.numLines).toBe(50);
    }
  });

  it("rejects force non-boolean", () => {
    const result = validateInput({ filePath: "test.txt", force: "yes" });
    expect(result.status).toBe("error");
  });

  it("accepts force boolean", () => {
    const result = validateInput({ filePath: "test.txt", force: true });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.force).toBe(true);
    }
  });

  it("accepts all valid params together", () => {
    const result = validateInput({
      filePath: "test.txt",
      force: false,
      startLine: 10,
      numLines: 20,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.filePath).toBe("test.txt");
      expect(result.value.force).toBe(false);
      expect(result.value.startLine).toBe(10);
      expect(result.value.numLines).toBe(20);
    }
  });
});

describe("createTool integration", () => {
  function makeContext(): CreateToolContext {
    return {
      fileIO: mockFileIO(),
      logger: mockLogger(),
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
      myDispatch: vi.fn(),
      edlRegisters: { registers: new Map(), nextSavedId: 0 },
      commandExec: {
        async spawn() {
          return { status: "error", error: "not implemented" };
        },
      },
      fileAccess: mockFileAccess({
        getFileInfo: async () => ({
          status: "ok",
          value: { size: 10, category: "text", mimeType: "text/plain" },
        }),
      }),
    };
  }

  it("creates GetFileTool for get_file requests", () => {
    const result = createTool(
      {
        id: "req-1" as ToolRequestId,
        toolName: "get_file" as unknown as ToolName,
        input: { filePath: "test.txt" },
      },
      makeContext(),
    );

    expect("status" in result).toBe(false);
    expect((result as GetFileTool).toolName).toBe("get_file");
  });

  it("returns error for invalid get_file input", () => {
    const result = createTool(
      {
        id: "req-1" as ToolRequestId,
        toolName: "get_file" as unknown as ToolName,
        input: { notFilePath: 123 },
      },
      makeContext(),
    );

    expect("status" in result && result.status === "error").toBe(true);
  });
});

describe("toolManager integration", () => {
  it("has get_file spec registered", () => {
    expect(TOOL_SPEC_MAP["get_file"]).toBeDefined();
    expect(TOOL_SPEC_MAP["get_file"].name).toBe("get_file");
  });
});