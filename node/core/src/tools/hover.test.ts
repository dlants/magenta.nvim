import { describe, it, expect, vi } from "vitest";
import * as Hover from "./hover.ts";
import type {
  LspClient,
  LspHoverResponse,
  LspDefinitionResponse,
} from "../capabilities/lsp-client.ts";
import type { FileIO } from "../capabilities/file-io.ts";
import type { ToolRequestId } from "../tool-types.ts";
import type { NvimCwd, HomeDir } from "../utils/files.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";

function createMockLspClient(overrides: Partial<LspClient> = {}): LspClient {
  return {
    requestHover: vi.fn().mockResolvedValue([]),
    requestDefinition: vi.fn().mockResolvedValue([]),
    requestTypeDefinition: vi.fn().mockResolvedValue([]),
    requestReferences: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function createMockFileIO(fileContent: string): FileIO {
  return {
    readFile: vi.fn().mockResolvedValue(fileContent),
    readBinaryFile: vi.fn(),
    writeFile: vi.fn(),
    fileExists: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
  };
}

const TEST_CWD = "/project" as NvimCwd;
const TEST_HOME = "/home/user" as HomeDir;

function makeRequest(
  symbol: string,
  filePath = "test.ts",
  context?: string,
): Hover.ToolRequest {
  return {
    id: "tool_1" as ToolRequestId,
    toolName: "hover" as const,
    input: {
      filePath: filePath as Hover.Input["filePath"],
      symbol,
      ...(context !== undefined ? { context } : {}),
    },
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

describe("hover unit tests", () => {
  it("returns formatted hover content with definition locations", async () => {
    const fileContent = "const foo = 42;";

    const hoverResponse: LspHoverResponse = [
      {
        result: {
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 9 },
          },
          contents: {
            kind: "markdown",
            value: "```typescript\nconst foo: number\n```",
          },
        },
      },
    ];

    const definitionResponse: LspDefinitionResponse = [
      {
        result: [
          {
            uri: "file:///project/test.ts",
            range: {
              start: { line: 0, character: 6 },
              end: { line: 0, character: 9 },
            },
          },
        ],
      },
    ];

    const lspClient = createMockLspClient({
      requestHover: vi.fn().mockResolvedValue(hoverResponse),
      requestDefinition: vi.fn().mockResolvedValue(definitionResponse),
    });

    const fileIO = createMockFileIO(fileContent);

    const invocation = Hover.execute(makeRequest("foo"), {
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
      lspClient,
      fileIO,
    });

    const text = await getResultText(invocation);
    expect(text).toContain("const foo: number");
    expect(text).toContain("Definition locations:");
    expect(text).toContain("test.ts:1:7");
  });

  it("uses word boundary matching for symbol", async () => {
    const fileContent = "interface Transport {}\ninterface AutoTransport {}";

    const hoverResponse: LspHoverResponse = [
      {
        result: {
          range: {
            start: { line: 0, character: 10 },
            end: { line: 0, character: 19 },
          },
          contents: { kind: "markdown", value: "interface Transport" },
        },
      },
    ];

    const lspClient = createMockLspClient({
      requestHover: vi.fn().mockResolvedValue(hoverResponse),
    });

    const fileIO = createMockFileIO(fileContent);

    const invocation = Hover.execute(makeRequest("Transport"), {
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
      lspClient,
      fileIO,
    });

    const text = await getResultText(invocation);
    expect(text).toContain("interface Transport");

    // Verify that the LSP was called with position corresponding to
    // the standalone "Transport" (index 10-18), not "AutoTransport"
    // The last char of "Transport" at index 10 is at index 18 (10 + 9 - 1)
    // which is line 0, character 18
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(lspClient.requestHover).toHaveBeenCalledWith(expect.anything(), {
      line: 0,
      character: 18,
    });
  });

  it("finds symbol within context when context provided", async () => {
    const fileContent = `{
  const res = request1()
}

{
  const res = request2()
}`;

    const lspClient = createMockLspClient({
      requestHover: vi.fn().mockResolvedValue([]),
    });
    const fileIO = createMockFileIO(fileContent);

    const invocation = Hover.execute(
      makeRequest("res", "test.ts", "  const res = request2()"),
      {
        cwd: TEST_CWD,
        homeDir: TEST_HOME,
        lspClient,
        fileIO,
      },
    );

    await invocation.promise;

    // The context "  const res = request2()" starts at the second block.
    // Within the context, "res" matches at offset 8 (after "  const ").
    // The symbolStart in the full buffer = contextIndex + 8.
    // The position passed to LSP is for the last char of "res" = symbolStart + 2.
    // Line 5 (0-indexed), character 10 (0-indexed) for the 's' of the second 'res'
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(lspClient.requestHover).toHaveBeenCalledWith(expect.anything(), {
      line: 5,
      character: 10,
    });
  });

  it("returns error when context not found", async () => {
    const fileContent = "const foo = 42;";
    const lspClient = createMockLspClient();
    const fileIO = createMockFileIO(fileContent);

    const invocation = Hover.execute(
      makeRequest("foo", "test.ts", "nonexistent"),
      {
        cwd: TEST_CWD,
        homeDir: TEST_HOME,
        lspClient,
        fileIO,
      },
    );

    const status = await getResultStatus(invocation);
    expect(status).toBe("error");
    const text = await getResultText(invocation);
    expect(text).toBe('Context "nonexistent" not found in file.');
  });

  it("returns error when symbol not found in file", async () => {
    const fileContent = "const foo = 42;";
    const lspClient = createMockLspClient();
    const fileIO = createMockFileIO(fileContent);

    const invocation = Hover.execute(makeRequest("missing"), {
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
      lspClient,
      fileIO,
    });

    const status = await getResultStatus(invocation);
    expect(status).toBe("error");
    const text = await getResultText(invocation);
    expect(text).toContain("not found");
  });

  it("returns error when file read fails", async () => {
    const lspClient = createMockLspClient();
    const fileIO = createMockFileIO("");
    (fileIO.readFile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ENOENT: no such file"),
    );

    const invocation = Hover.execute(makeRequest("foo"), {
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
      lspClient,
      fileIO,
    });

    const status = await getResultStatus(invocation);
    expect(status).toBe("error");
    const text = await getResultText(invocation);
    expect(text).toContain("Failed to read file");
    expect(text).toContain("ENOENT");
  });

  it("includes type definition locations when available", async () => {
    const fileContent = "const foo: MyType = {};";

    const hoverResponse: LspHoverResponse = [
      {
        result: {
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 9 },
          },
          contents: { kind: "markdown", value: "const foo: MyType" },
        },
      },
    ];

    const definitionResponse: LspDefinitionResponse = [
      {
        result: [
          {
            uri: "file:///project/test.ts",
            range: {
              start: { line: 0, character: 6 },
              end: { line: 0, character: 9 },
            },
          },
        ],
      },
    ];

    const typeDefinitionResponse: LspDefinitionResponse = [
      {
        result: [
          {
            uri: "file:///project/types.ts",
            range: {
              start: { line: 4, character: 0 },
              end: { line: 4, character: 10 },
            },
          },
        ],
      },
    ];

    const lspClient = createMockLspClient({
      requestHover: vi.fn().mockResolvedValue(hoverResponse),
      requestDefinition: vi.fn().mockResolvedValue(definitionResponse),
      requestTypeDefinition: vi.fn().mockResolvedValue(typeDefinitionResponse),
    });

    const fileIO = createMockFileIO(fileContent);

    const invocation = Hover.execute(makeRequest("foo"), {
      cwd: TEST_CWD,
      homeDir: TEST_HOME,
      lspClient,
      fileIO,
    });

    const text = await getResultText(invocation);
    expect(text).toContain("Definition locations:");
    expect(text).toContain("test.ts:1:7");
    expect(text).toContain("Type definition locations:");
    expect(text).toContain("types.ts:5:1");
  });
});
