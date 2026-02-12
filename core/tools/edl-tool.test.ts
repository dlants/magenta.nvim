import { describe, it, expect, vi, beforeEach } from "vitest";
import { EdlTool, extractEdlData, type Msg } from "./edl-tool.ts";
import type { FileIO } from "./environment.ts";
import type { FileAccess } from "./environment.ts";
import type { Logger } from "../logger.ts";
import type { AbsFilePath, Cwd, HomeDir } from "../utils/files.ts";
import type { ToolRequestId, ToolName, ToolMsg } from "./types.ts";
import type { EdlRegisters } from "../edl/index.ts";
import type { ToolRequest } from "./specs/edl.ts";
import type { Result } from "../utils/result.ts";
import { createTool, type CreateToolContext } from "./create-tool.ts";
import { getToolSpecs, getToolSpec, TOOL_SPEC_MAP } from "./toolManager.ts";

function mockFileIO(files: Record<string, string> = {}): FileIO {
  const store = new Map<string, string>(Object.entries(files));
  return {
    async readFile(path: AbsFilePath): Promise<Result<string>> {
      const content = store.get(path);
      if (content === undefined) {
        return { status: "error", error: `File not found: ${path}` };
      }
      return { status: "ok", value: content };
    },
    async writeFile(path: AbsFilePath, content: string): Promise<Result<void>> {
      store.set(path, content);
      return { status: "ok", value: undefined };
    },
    async fileExists(path: AbsFilePath): Promise<Result<boolean>> {
      return { status: "ok", value: store.has(path) };
    },
    async mkdir(): Promise<Result<void>> {
      return { status: "ok", value: undefined };
    },
    async readDir(): Promise<
      Result<
        { name: string; type: "file" | "directory" | "symlink" | "other" }[]
      >
    > {
      return { status: "ok", value: [] };
    },
  };
}

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

function makeRequest(script: string): ToolRequest {
  return {
    id: "test-tool-1" as ToolRequestId,
    toolName: "edl" as unknown as ToolName,
    input: { script },
  };
}

function waitForDone(tool: EdlTool): Promise<void> {
  return vi.waitFor(() => {
    expect(tool.isDone()).toBe(true);
  });
}

describe("EdlTool", () => {
  let dispatched: Msg[];
  let fileIO: FileIO;
  let logger: Logger;
  let edlRegisters: EdlRegisters;

  beforeEach(() => {
    dispatched = [];
    fileIO = mockFileIO({
      "/test/project/src/file.ts": "const x = 1;\nconst y = 2;\n",
    });
    logger = mockLogger();
    edlRegisters = { registers: new Map(), nextSavedId: 0 };
  });

  function createEdlTool(script: string) {
    const request = makeRequest(script);
    let tool: EdlTool;
    tool = new EdlTool(request, {
      fileIO,
      logger,
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
      myDispatch: (msg: Msg) => {
        dispatched.push(msg);
        tool.update(msg as unknown as ToolMsg);
      },
      edlRegisters,
    });
    return tool;
  }

  it("executes a simple replacement script", async () => {
    const script = [
      "file `src/file.ts`",
      "select_one <<END",
      "const x = 1;",
      "END",
      "replace <<END",
      "const x = 42;",
      "END",
    ].join("\n");

    const tool = createEdlTool(script);
    expect(tool.state.state).toBe("processing");
    expect(tool.isDone()).toBe(false);
    expect(tool.isPendingUserAction()).toBe(false);

    await waitForDone(tool);

    expect(dispatched.length).toBe(1);
    expect(dispatched[0].type).toBe("finish");
    expect(dispatched[0].result.status).toBe("ok");

    const result = tool.getToolResult();
    expect(result.result.status).toBe("ok");

    const data = extractEdlData(result);
    expect(data).toBeDefined();
    expect(data!.mutations).toHaveLength(1);
    expect(data!.mutations[0].path).toBe("src/file.ts");
  });

  it("handles parse errors", async () => {
    const tool = createEdlTool("invalid_command foo bar");

    await waitForDone(tool);

    expect(dispatched.length).toBe(1);
    expect(dispatched[0].result.status).toBe("error");
  });

  it("handles file not found", async () => {
    const script = [
      "file `nonexistent.ts`",
      "select_one <<END",
      "something",
      "END",
    ].join("\n");

    const tool = createEdlTool(script);
    await waitForDone(tool);

    expect(dispatched.length).toBe(1);
    const result = tool.getToolResult();
    const data = extractEdlData(result);
    expect(data).toBeDefined();
    expect(data!.fileErrors.length).toBeGreaterThan(0);
  });

  it("returns processing result before done", () => {
    const tool = createEdlTool("file `src/file.ts`");
    const result = tool.getToolResult();
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      expect(result.result.value[0].type).toBe("text");
    }
  });

  it("can be aborted", () => {
    const tool = createEdlTool("file `src/file.ts`");
    const result = tool.abort();

    expect(tool.isDone()).toBe(true);
    expect(tool.aborted).toBe(true);
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("aborted");
    }
  });

  it("abort returns existing result if already done", async () => {
    const tool = createEdlTool("file `src/file.ts`");
    await waitForDone(tool);

    const result = tool.abort();
    expect(result.result.status).toBe("ok");
  });

  it("preserves EDL registers across invocations", async () => {
    const script1 = [
      "newfile `src/new.ts`",
      "insert_after <<END",
      "hello world",
      "END",
    ].join("\n");

    const tool1 = createEdlTool(script1);
    await waitForDone(tool1);

    dispatched = [];
    const script2 = [
      "file `src/file.ts`",
      "select_one <<END",
      "const x = 1;",
      "END",
      "replace <<END",
      "const x = 99;",
      "END",
    ].join("\n");

    const tool2 = createEdlTool(script2);
    await waitForDone(tool2);

    expect(dispatched[0].result.status).toBe("ok");
  });

  it("creates new files", async () => {
    const script = [
      "newfile `src/brand-new.ts`",
      "insert_after <<END",
      'export const greeting = "hello";',
      "END",
    ].join("\n");

    const tool = createEdlTool(script);
    await waitForDone(tool);

    expect(dispatched[0].result.status).toBe("ok");
    const data = extractEdlData(tool.getToolResult());
    expect(data).toBeDefined();
    expect(data!.mutations).toHaveLength(1);
    expect(data!.mutations[0].content).toContain("hello");
  });
});

describe("extractEdlData", () => {
  it("returns undefined for error results", () => {
    const result = extractEdlData({
      type: "tool_result",
      id: "test" as ToolRequestId,
      result: { status: "error", error: "failed" },
    });
    expect(result).toBeUndefined();
  });

  it("extracts data from valid result", () => {
    const data = {
      trace: [],
      mutations: [],
      finalSelection: undefined,
      fileErrors: [],
    };
    const result = extractEdlData({
      type: "tool_result",
      id: "test" as ToolRequestId,
      result: {
        status: "ok",
        value: [
          { type: "text" as const, text: "formatted output" },
          {
            type: "text" as const,
            text: `\n\n__EDL_DATA__${JSON.stringify(data)}`,
          },
        ],
      },
    });
    expect(result).toEqual(data);
  });
});

describe("toolManager", () => {
  it("has edl spec registered", () => {
    expect(TOOL_SPEC_MAP["edl"]).toBeDefined();
    expect(TOOL_SPEC_MAP["edl"].name).toBe("edl");
  });

  it("getToolSpecs returns all specs", () => {
    const specs = getToolSpecs();
    expect(specs.length).toBeGreaterThanOrEqual(1);
    expect(specs.some((s) => s.name === "edl")).toBe(true);
  });

  it("getToolSpec retrieves by name", () => {
    const spec = getToolSpec("edl" as ToolName);
    expect(spec).toBeDefined();
    expect(spec!.name).toBe("edl");
  });

  it("getToolSpec returns undefined for unknown", () => {
    const spec = getToolSpec("nonexistent" as ToolName);
    expect(spec).toBeUndefined();
  });
});

describe("createTool", () => {
  it("creates EdlTool for edl requests", () => {
    const context: CreateToolContext = {
      fileIO: mockFileIO(),
      logger: mockLogger(),
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
      myDispatch: vi.fn(),
      edlRegisters: { registers: new Map(), nextSavedId: 0 },      fileAccess: {
        async getFileInfo() {
          return { status: "error", error: "not implemented" };
        },
        async readBinaryFileBase64() {
          return { status: "error", error: "not implemented" };
        },
        async extractPDFPage() {
          return { status: "error", error: "not implemented" };
        },
        async getPDFPageCount() {
          return { status: "error", error: "not implemented" };
        },
      },
    };

    const result = createTool(
      {
        id: "req-1" as ToolRequestId,
        toolName: "edl" as unknown as ToolName,
        input: { script: "file `test.ts`" },
      },
      context,
    );

    expect("status" in result).toBe(false);
    expect((result as unknown as EdlTool).toolName).toBe("edl");
  });

  it("returns error for unknown tool", () => {
    const context: CreateToolContext = {
      fileIO: mockFileIO(),
      logger: mockLogger(),
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
      myDispatch: vi.fn(),
      edlRegisters: { registers: new Map(), nextSavedId: 0 },      fileAccess: {
        async getFileInfo() {
          return { status: "error", error: "not implemented" };
        },
        async readBinaryFileBase64() {
          return { status: "error", error: "not implemented" };
        },
        async extractPDFPage() {
          return { status: "error", error: "not implemented" };
        },
        async getPDFPageCount() {
          return { status: "error", error: "not implemented" };
        },
      },
    };

    const result = createTool(
      {
        id: "req-1" as ToolRequestId,
        toolName: "nonexistent" as ToolName,
        input: {},
      },
      context,
    );

    expect("status" in result && result.status === "error").toBe(true);
  });

  it("returns error for invalid edl input", () => {
    const context: CreateToolContext = {
      fileIO: mockFileIO(),
      logger: mockLogger(),
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
      myDispatch: vi.fn(),
      edlRegisters: { registers: new Map(), nextSavedId: 0 },      fileAccess: {
        async getFileInfo() {
          return { status: "error", error: "not implemented" };
        },
        async readBinaryFileBase64() {
          return { status: "error", error: "not implemented" };
        },
        async extractPDFPage() {
          return { status: "error", error: "not implemented" };
        },
        async getPDFPageCount() {
          return { status: "error", error: "not implemented" };
        },
      },
    };

    const result = createTool(
      {
        id: "req-1" as ToolRequestId,
        toolName: "edl" as unknown as ToolName,
        input: { notScript: 123 },
      },
      context,
    );

    expect("status" in result && result.status === "error").toBe(true);
  });
});
