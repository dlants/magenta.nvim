import { type Result } from "../utils/result.ts";

import { getOrOpenBuffer } from "../utils/buffers.ts";
import type { NvimBuffer } from "../nvim/buffer.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { Lsp } from "../capabilities/lsp.ts";
import { calculateStringPosition } from "../tea/util.ts";
import type { PositionString, Row0Indexed, StringIdx } from "../nvim/window.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import {
  resolveFilePath,
  type NvimCwd,
  type UnresolvedFilePath,
  type HomeDir,
} from "../utils/files.ts";
import type { ToolName, GenericToolRequest, ToolInvocation } from "./types.ts";

export function execute(
  request: ToolRequest,
  context: {
    nvim: Nvim;
    cwd: NvimCwd;
    homeDir: HomeDir;
    lsp: Lsp;
  },
): ToolInvocation {
  let aborted = false;

  const promise = (async (): Promise<ProviderToolResult> => {
    try {
      const { lsp, nvim, cwd, homeDir } = context;
      const filePath = request.input.filePath;
      const bufferResult = await getOrOpenBuffer({
        unresolvedPath: filePath,
        context: { nvim, cwd, homeDir },
      });

      if (aborted) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Request was aborted by the user.",
          },
        };
      }

      let buffer: NvimBuffer;
      let bufferContent: string;
      if (bufferResult.status == "ok") {
        bufferContent = (
          await bufferResult.buffer.getLines({
            start: 0 as Row0Indexed,
            end: -1 as Row0Indexed,
          })
        ).join("\n");
        buffer = bufferResult.buffer;
      } else {
        return {
          type: "tool_result",
          id: request.id,
          result: { status: "error", error: bufferResult.error },
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
        };
      }

      const symbolPos = calculateStringPosition(
        { row: 0, col: 0 } as PositionString,
        bufferContent,
        (symbolStart + request.input.symbol.length - 1) as StringIdx,
      );

      const result = await lsp.requestReferences(buffer, symbolPos);

      if (aborted) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Request was aborted by the user.",
          },
        };
      }

      let content = "";
      for (const lspResult of result) {
        if (lspResult != null && lspResult.result) {
          for (const ref of lspResult.result) {
            const uri = ref.uri.startsWith("file://")
              ? ref.uri.slice(7)
              : ref.uri;
            const absFilePath = resolveFilePath(
              context.cwd,
              uri as UnresolvedFilePath,
              context.homeDir,
            );
            content += `${absFilePath}:${ref.range.start.line + 1}:${ref.range.start.character}\n`;
          }
        }
      }

      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: [{ type: "text", text: content || "No references found" }],
        },
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
        };
      }
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: `Error requesting references: ${error instanceof Error ? error.message : String(error)}`,
        },
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
  if (typeof input.filePath != "string") {
    return { status: "error", error: "expected input.filePath to be a string" };
  }

  if (typeof input.symbol != "string") {
    return { status: "error", error: "expected input.symbol to be a string" };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
