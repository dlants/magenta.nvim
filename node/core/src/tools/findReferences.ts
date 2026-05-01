import type { FileIO } from "../capabilities/file-io.ts";

import type { LspClient } from "../capabilities/lsp-client.ts";
import {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderToolResult,
  type ProviderToolSpec,
} from "../providers/provider-types.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolName,
} from "../tool-types.ts";
import {
  type HomeDir,
  type NvimCwd,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import type { Result } from "../utils/result.ts";
import type { PositionString, StringIdx } from "../utils/string-position.ts";
import { calculateStringPosition } from "../utils/string-position.ts";
export type StructuredResult = { toolName: "find_references" };

export function execute(
  request: ToolRequest,
  context: {
    cwd: NvimCwd;
    homeDir: HomeDir;
    lspClient: LspClient;
    fileIO: FileIO;
  },
): ToolInvocation {
  let aborted = false;

  const promise = (async (): Promise<ProviderToolResult> => {
    try {
      const filePath = request.input.filePath;
      const absFilePath = resolveFilePath(
        context.cwd,
        filePath,
        context.homeDir,
      );

      let bufferContent: string;
      try {
        bufferContent = await context.fileIO.readFile(absFilePath);
      } catch (e) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: `Failed to read file ${absFilePath}: ${e instanceof Error ? e.message : String(e)}`,
          },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        };
      }

      if (aborted) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Request was aborted by the user.",
          },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        };
      }

      const symbolStart = bufferContent.indexOf(
        request.input.symbol,
      ) as StringIdx;

      if (symbolStart === -1) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: `Symbol "${request.input.symbol}" not found in file.`,
          },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        };
      }

      const symbolPos = calculateStringPosition(
        { row: 0, col: 0 } as PositionString,
        bufferContent,
        (symbolStart + request.input.symbol.length - 1) as StringIdx,
      );

      const lspPosition = { line: symbolPos.row, character: symbolPos.col };

      const result = await context.lspClient.requestReferences(
        absFilePath,
        lspPosition,
      );

      if (aborted) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Request was aborted by the user.",
          },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        };
      }

      let content = "";
      for (const lspResult of result) {
        if (lspResult?.result) {
          for (const ref of lspResult.result) {
            const uri = ref.uri.startsWith("file://")
              ? ref.uri.slice(7)
              : ref.uri;
            const absRefPath = resolveFilePath(
              context.cwd,
              uri as UnresolvedFilePath,
              context.homeDir,
            );
            content += `${absRefPath}:${ref.range.start.line + 1}:${ref.range.start.character}\n`;
          }
        }
      }

      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: [{ type: "text", text: content || "No references found", nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }],
          structuredResult: { toolName: "find_references" },
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      };
    } catch (error) {
      if (aborted) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Request was aborted by the user.",
          },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        };
      }
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: `Error requesting references: ${error instanceof Error ? error.message : String(error)}`,
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      };
    }
  })();

  return {
    promise,
    abort: () => {
      aborted = true;
    },
  };
}

export const spec: ProviderToolSpec = {
  name: "find_references" as ToolName,
  description: "Find all references to a symbol in the workspace.",
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description:
          "Path to the file containing the symbol. Prefer absolute paths. Relative paths are resolved from the project root.",
      },
      symbol: {
        type: "string",
        description: `The symbol to find references for.
We will use the first occurrence of the symbol.
We will use the right-most character of this string, so if the string is "a.b.c", we will find references for c.`,
      },
    },
    required: ["filePath", "symbol"],
  },
};

export type Input = {
  filePath: UnresolvedFilePath;
  symbol: string;
};

export type ToolRequest = GenericToolRequest<"find_references", Input>;

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.filePath !== "string") {
    return { status: "error", error: "expected input.filePath to be a string" };
  }

  if (typeof input.symbol !== "string") {
    return { status: "error", error: "expected input.symbol to be a string" };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
