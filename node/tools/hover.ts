import { d, withInlineCode, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { CompletedToolInfo } from "./types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getOrOpenBuffer } from "../utils/buffers.ts";
import type { NvimBuffer } from "../nvim/buffer.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Lsp, LspDefinitionResponse, LspRange } from "../lsp.ts";
import { calculateStringPosition } from "../tea/util.ts";
import type { PositionString, Row0Indexed, StringIdx } from "../nvim/window.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import type { GenericToolRequest, StaticTool, ToolName } from "./types.ts";
import path from "path";

export type ToolRequest = GenericToolRequest<"hover", Input>;

export type State =
  | {
      state: "processing";
    }
  | {
      state: "done";
      result: ProviderToolResult;
    };

export type Msg = {
  type: "finish";
  result: Result<ProviderToolResultContent[]>;
};

export class HoverTool implements StaticTool {
  state: State;
  toolName = "hover" as const;
  aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public context: {
      nvim: Nvim;
      cwd: NvimCwd;
      lsp: Lsp;
      myDispatch: (msg: Msg) => void;
    },
  ) {
    this.state = {
      state: "processing",
    };
    this.requestHover().catch((error) => {
      this.context.nvim.logger.error(
        `Error requesting hover: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  update(msg: Msg) {
    switch (msg.type) {
      case "finish":
        if (this.state.state == "processing") {
          this.state = {
            state: "done",
            result: {
              type: "tool_result",
              id: this.request.id,
              result: msg.result,
            },
          };
        }
        return;
      default:
        assertUnreachable(msg.type);
    }
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  isPendingUserAction(): boolean {
    return false;
  }

  abort(): ProviderToolResult {
    if (this.state.state === "done") {
      return this.getToolResult();
    }

    this.aborted = true;

    const result: ProviderToolResult = {
      type: "tool_result",
      id: this.request.id,
      result: {
        status: "error",
        error: "Request was aborted by the user.",
      },
    };

    this.state = {
      state: "done",
      result,
    };

    return result;
  }

  async requestHover() {
    const { lsp } = this.context;
    const filePath = this.request.input.filePath;
    const bufferResult = await getOrOpenBuffer({
      unresolvedPath: filePath,
      context: this.context,
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
      if (this.aborted) return;
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: bufferResult.error,
        },
      });
      return;
    }

    // Find the symbol bounded by non-alphanumeric characters
    let symbolStart: StringIdx;

    if (this.request.input.context) {
      // If context is provided, find the context first
      const contextIndex = bufferContent.indexOf(this.request.input.context);
      if (contextIndex === -1) {
        if (this.aborted) return;
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: `Context "${this.request.input.context}" not found in file.`,
          },
        });
        return;
      }

      // Find the symbol within the context
      const contextContent = bufferContent.substring(
        contextIndex,
        contextIndex + this.request.input.context.length,
      );
      const symbolRegex = new RegExp(
        `(?<![a-zA-Z0-9_])${this.request.input.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-zA-Z0-9_])`,
      );
      const match = contextContent.match(symbolRegex);
      if (!match || match.index === undefined) {
        if (this.aborted) return;
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: `Symbol "${this.request.input.symbol}" not found within the provided context.`,
          },
        });
        return;
      }
      symbolStart = (contextIndex + match.index) as StringIdx;
    } else {
      // Original behavior - find first occurrence
      const symbolRegex = new RegExp(
        `(?<![a-zA-Z0-9_])${this.request.input.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-zA-Z0-9_])`,
      );
      const match = bufferContent.match(symbolRegex);
      if (!match || match.index === undefined) {
        if (this.aborted) return;
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: `Symbol "${this.request.input.symbol}" not found in file.`,
          },
        });
        return;
      }
      symbolStart = match.index as StringIdx;
    }

    const symbolPos = calculateStringPosition(
      { row: 0, col: 0 } as PositionString,
      bufferContent,
      (symbolStart + this.request.input.symbol.length - 1) as StringIdx,
    );

    try {
      const [hoverResult, definitionResult, typeDefinitionResult] =
        await Promise.all([
          lsp.requestHover(buffer, symbolPos),
          lsp.requestDefinition(buffer, symbolPos).catch(() => null),
          lsp.requestTypeDefinition(buffer, symbolPos).catch(() => null),
        ]);

      let content = "";

      // Add hover information
      for (const lspResult of hoverResult) {
        if (lspResult != null) {
          content += `${lspResult.result.contents.value}
`;
        }
      }

      // Helper function to extract location info from different LSP response formats
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

      // Add definition locations
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
            let displayPath = absolutePath;

            if (this.context.cwd) {
              const relativePath = path.relative(
                this.context.cwd,
                absolutePath,
              );
              displayPath = relativePath.startsWith("../")
                ? absolutePath
                : relativePath;
            }

            const line = def.range.start.line + 1;
            const char = def.range.start.character + 1;
            content += `  ${displayPath}:${line}:${char}\n`;
          }
        }
      }

      // Add type definition locations
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
            let displayPath = absolutePath;

            if (this.context.cwd) {
              const relativePath = path.relative(
                this.context.cwd,
                absolutePath,
              );
              displayPath = relativePath.startsWith("../")
                ? absolutePath
                : relativePath;
            }

            const line = typeDef.range.start.line + 1;
            const char = typeDef.range.start.character + 1;
            content += `  ${displayPath}:${line}:${char}\n`;
          }
        }
      }

      if (this.aborted) return;
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "ok",
          value: [{ type: "text", text: content }],
        },
      });
    } catch (error) {
      if (this.aborted) return;
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `Error requesting hover: ${(error as Error).message}`,
        },
      });
    }
  }

  getToolResult(): ProviderToolResult {
    switch (this.state.state) {
      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              { type: "text", text: `This tool use is being processed.` },
            ],
          },
        };
      case "done":
        return this.state.result;
      default:
        assertUnreachable(this.state);
    }
  }

  renderSummary() {
    switch (this.state.state) {
      case "processing":
        return d`🔍⚙️ hover ${withInlineCode(d`\`${this.request.input.symbol}\``)} in ${withInlineCode(d`\`${this.request.input.filePath}\``)}`;
      case "done":
        return renderCompletedSummary({
          request: this.request as CompletedToolInfo["request"],
          result: this.state.result,
        });
      default:
        assertUnreachable(this.state);
    }
  }
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const status = info.result.result.status === "error" ? "❌" : "✅";
  return d`🔍${status} hover ${withInlineCode(d`\`${input.symbol}\``)} in ${withInlineCode(d`\`${input.filePath}\``)}`;
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
        description: "Path to the file containing the symbol.",
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
