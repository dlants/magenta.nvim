import { describe, it, expect, vi } from "vitest";
import * as FindReferences from "./findReferences.ts";
import type {
  LspClient,
  LspReferencesResponse,
} from "../capabilities/lsp-client.ts";
import type { FileIO } from "../capabilities/file-io.ts";
import type { ToolRequestId } from "../tool-types.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";
import type { NvimCwd, HomeDir, UnresolvedFilePath } from "../utils/files.ts";

const CWD = "/project" as NvimCwd;
const HOME = "/home/user" as HomeDir;

function createMockLspClient(
  referencesResponse: LspReferencesResponse,
): LspClient {
  return {
    requestHover: vi.fn(),
    requestReferences: vi.fn().mockResolvedValue(referencesResponse),
    requestDefinition: vi.fn(),
    requestTypeDefinition: vi.fn(),
  };
}

function createMockFileIO(content: string): FileIO {
  return {
    readFile: vi.fn().mockResolvedValue(content),
    readBinaryFile: vi.fn(),
    writeFile: vi.fn(),
    fileExists: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
  };
}

function createFailingFileIO(error: Error): FileIO {
  return {
    readFile: vi.fn().mockRejectedValue(error),
    readBinaryFile: vi.fn(),
    writeFile: vi.fn(),
    fileExists: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
  };
}

async function getResultText(invocation: {
  promise: Promise<ProviderToolResult>;
}): Promise<string> {
  const result = await invocation.promise;
  if (result.result.status === "ok") {
    return (result.result.value[0] as { type: "text"; text: string }).text;
  }
  return result.result.error;
}

async function getResultStatus(invocation: {
  promise: Promise<ProviderToolResult>;
}): Promise<"ok" | "error"> {
  const result = await invocation.promise;
  return result.result.status;
}

describe("findReferences unit tests", () => {
  it("returns formatted reference locations", async () => {
    const fileContent = "const foo = 42;\nconsole.log(foo);";
    const referencesResponse: LspReferencesResponse = [
      {
        result: [
          {
            uri: "file:///project/src/main.ts",
            range: {
              start: { line: 0, character: 6 },
              end: { line: 0, character: 9 },
            },
          },
          {
            uri: "file:///project/src/utils.ts",
            range: {
              start: { line: 4, character: 12 },
              end: { line: 4, character: 15 },
            },
          },
        ],
      },
    ];

    const invocation = FindReferences.execute(
      {
        id: "tool_1" as ToolRequestId,
        toolName: "find_references" as const,
        input: {
          filePath: "/project/src/main.ts" as UnresolvedFilePath,
          symbol: "foo",
        },
      },
      {
        cwd: CWD,
        homeDir: HOME,
        lspClient: createMockLspClient(referencesResponse),
        fileIO: createMockFileIO(fileContent),
      },
    );

    const status = await getResultStatus(invocation);
    expect(status).toBe("ok");

    const text = await getResultText(invocation);
    expect(text).toContain("/project/src/main.ts:1:6");
    expect(text).toContain("/project/src/utils.ts:5:12");
  });

  it("returns error when symbol not found", async () => {
    const fileContent = "const foo = 42;\nconsole.log(foo);";

    const invocation = FindReferences.execute(
      {
        id: "tool_2" as ToolRequestId,
        toolName: "find_references" as const,
        input: {
          filePath: "/project/src/main.ts" as UnresolvedFilePath,
          symbol: "missing",
        },
      },
      {
        cwd: CWD,
        homeDir: HOME,
        lspClient: createMockLspClient([]),
        fileIO: createMockFileIO(fileContent),
      },
    );

    const result = await invocation.promise;
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain(
        'Symbol "missing" not found in file.',
      );
    }
  });

  it("returns error when file read fails", async () => {
    const invocation = FindReferences.execute(
      {
        id: "tool_3" as ToolRequestId,
        toolName: "find_references" as const,
        input: {
          filePath: "/project/src/main.ts" as UnresolvedFilePath,
          symbol: "foo",
        },
      },
      {
        cwd: CWD,
        homeDir: HOME,
        lspClient: createMockLspClient([]),
        fileIO: createFailingFileIO(new Error("ENOENT: no such file")),
      },
    );

    const result = await invocation.promise;
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("Failed to read file");
      expect(result.result.error).toContain("ENOENT");
    }
  });

  it("returns No references found when LSP returns empty", async () => {
    const fileContent = "const foo = 42;";
    const emptyResponse: LspReferencesResponse = [{ result: [] }];

    const invocation = FindReferences.execute(
      {
        id: "tool_4" as ToolRequestId,
        toolName: "find_references" as const,
        input: {
          filePath: "/project/src/main.ts" as UnresolvedFilePath,
          symbol: "foo",
        },
      },
      {
        cwd: CWD,
        homeDir: HOME,
        lspClient: createMockLspClient(emptyResponse),
        fileIO: createMockFileIO(fileContent),
      },
    );

    const status = await getResultStatus(invocation);
    expect(status).toBe("ok");

    const text = await getResultText(invocation);
    expect(text).toBe("No references found");
  });
});
