import { type Result } from "../utils/result.ts";

import { getOrOpenBuffer } from "../utils/buffers.ts";
import type { NvimBuffer } from "../nvim/buffer.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type {
  Lsp,
  LspDefinitionResponse,
  LspRange,
} from "../capabilities/lsp.ts";
import { calculateStringPosition } from "../tea/util.ts";
import type { PositionString, Row0Indexed, StringIdx } from "../nvim/window.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import {
  displayPath,
  type AbsFilePath,
  type HomeDir,
  type NvimCwd,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import type { GenericToolRequest, ToolName, ToolInvocation } from "./types.ts";

export type ToolRequest = GenericToolRequest<"hover", Input>;

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
      const filePath = request.input.filePath;
      const bufferResult = await getOrOpenBuffer({
        unresolvedPath: filePath,
        context: {
          nvim: context.nvim,
          cwd: context.cwd,
          homeDir: context.homeDir,
        },
      });

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

      // Find the symbol bounded by non-alphanumeric characters
      let symbolStart: StringIdx;

      if (request.input.context) {
        const contextIndex = bufferContent.indexOf(request.input.context);
        if (contextIndex === -1) {
          return {
            type: "tool_result",
            id: request.id,
            result: {
              status: "error",
              error: `Context "${request.input.context}" not found in file.`,
            },
          };
        }

        const contextContent = bufferContent.substring(
          contextIndex,
          contextIndex + request.input.context.length,
        );
        const symbolRegex = new RegExp(
          `(?<![a-zA-Z0-9_])${request.input.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-zA-Z0-9_])`,
        );
        const match = contextContent.match(symbolRegex);
        if (!match || match.index === undefined) {
          return {
            type: "tool_result",
            id: request.id,
            result: {
              status: "error",
              error: `Symbol "${request.input.symbol}" not found within the provided context.`,
            },
          };
        }
        symbolStart = (contextIndex + match.index) as StringIdx;
      } else {
        const symbolRegex = new RegExp(
          `(?<![a-zA-Z0-9_])${request.input.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-zA-Z0-9_])`,
        );
        const match = bufferContent.match(symbolRegex);
        if (!match || match.index === undefined) {
          return {
            type: "tool_result",
            id: request.id,
            result: {
              status: "error",
              error: `Symbol "${request.input.symbol}" not found in file.`,
            },
          };
        }
        symbolStart = match.index as StringIdx;
      }

      const symbolPos = calculateStringPosition(
        { row: 0, col: 0 } as PositionString,
        bufferContent,
        (symbolStart + request.input.symbol.length - 1) as StringIdx,
      );

      const lspTimeout = <T>(p: Promise<T>, label: string): Promise<T> =>
        Promise.race([
          p,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`LSP ${label} request timed out`)),
              10_000,
            ),
          ),
        ]);

      const [hoverResult, definitionResult, typeDefinitionResult] =
        await Promise.all([
          lspTimeout(context.lsp.requestHover(buffer, symbolPos), "hover"),
          lspTimeout(
            context.lsp.requestDefinition(buffer, symbolPos),
            "definition",
          ).catch(() => null),
          lspTimeout(
            context.lsp.requestTypeDefinition(buffer, symbolPos),
            "typeDefinition",
          ).catch(() => null),
        ]);

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

      for (const lspResult of hoverResult) {
        if (lspResult != null) {
          content += `${lspResult.result.contents.value}\n`;
        }
      }

      const extractLocationInfo = (
        def: NonNullable<LspDefinitionResponse[number]>["result"][number],
      ): {
        uri: string;
        range: LspRange;
      } | null => {
        if ("uri" in def && "range" in def) {
          return { uri: def.uri, range: def.range };
        }
        if ("targetUri" in def && "targetRange" in def) {
          return { uri: def.targetUri, range: def.targetRange };
        }
        return null;
      };

      if (definitionResult) {
        const definitions = definitionResult
          .filter((result) => result != null)
          .flatMap((result) => result.result)
          .map(extractLocationInfo)
          .filter((loc): loc is NonNullable<typeof loc> => loc !== null);

        if (definitions.length > 0) {
          content += "\nDefinition locations:\n";
          for (const def of definitions) {
            const absolutePath = def.uri.replace(/^file:\/\//, "");
            const pathForDisplay = displayPath(
              context.cwd,
              absolutePath as AbsFilePath,
              context.homeDir,
            );
            const line = def.range.start.line + 1;
            const char = def.range.start.character + 1;
            content += `  ${pathForDisplay}:${line}:${char}\n`;
          }
        }
      }

      if (typeDefinitionResult) {
        const typeDefinitions = typeDefinitionResult
          .filter((result) => result != null)
          .flatMap((result) => result.result)
          .map(extractLocationInfo)
          .filter((loc): loc is NonNullable<typeof loc> => loc !== null);

        if (typeDefinitions.length > 0) {
          content += "\nType definition locations:\n";
          for (const typeDef of typeDefinitions) {
            const absolutePath = typeDef.uri.replace(/^file:\/\//, "");
            const pathForDisplay = displayPath(
              context.cwd,
              absolutePath as AbsFilePath,
              context.homeDir,
            );
            const line = typeDef.range.start.line + 1;
            const char = typeDef.range.start.character + 1;
            content += `  ${pathForDisplay}:${line}:${char}\n`;
          }
        }
      }

      return {
        type: "tool_result",
        id: request.id,
        result: { status: "ok", value: [{ type: "text", text: content }] },
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
          error: `Error requesting hover: ${error instanceof Error ? error.message : String(error)}`,
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
  name: "hover" as ToolName,
  description:
    "Get hover information for a symbol in a file. This will use the attached lsp client if one is available.",
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
        description: `The symbol to get hover information for.
We will use the first occurrence of the complete symbol, so if the symbol is Transport, we will hover the first instance of "Transport", but not "AutoTransport".`,
      },
      context: {
        type: "string",
        description: `Optional context to disambiguate which instance of the symbol to target when there are multiple occurrences. This should be an exact match for a portion of the file containing the target symbol.

For example, if you have multiple instances of a variable "res":
\`\`\`
{
  const res = request1()
}

{
  const res = request2()
}
\`\`\`

You could use context "  const res = request2()" to specify the second instance. Context should match the content of the file exactly, including whitespace.
If context is provided but not found in the file, the tool will fail.`,
      },
    },
    required: ["filePath", "symbol"],
  },
};

export type Input = {
  filePath: UnresolvedFilePath;
  symbol: string;
  context?: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.filePath != "string") {
    return { status: "error", error: "expected input.filePath to be a string" };
  }

  if (typeof input.symbol != "string") {
    return { status: "error", error: "expected input.symbol to be a string" };
  }

  if (input.context !== undefined && typeof input.context != "string") {
    return { status: "error", error: "expected input.context to be a string" };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
