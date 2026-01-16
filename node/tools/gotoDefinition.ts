import { d, withInlineCode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getOrOpenBuffer } from "../utils/buffers.ts";
import type { NvimBuffer } from "../nvim/buffer.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Lsp, LspRange } from "../lsp.ts";
import { calculateStringPosition } from "../tea/util.ts";
import type { PositionString, Row0Indexed, StringIdx } from "../nvim/window.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import type { StaticTool, ToolName } from "./types.ts";
import path from "path";
import fs from "fs/promises";

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

export class GotoDefinitionTool implements StaticTool {
  state: State;
  toolName = "goto_definition" as const;

  constructor(
    public request: Extract<StaticToolRequest, { toolName: "goto_definition" }>,
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
    this.requestDefinition().catch((error) => {
      this.context.nvim.logger.error(
        `Error requesting definition: ${error instanceof Error ? error.message : String(error)}`,
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

  abort() {
    this.state = {
      state: "done",
      result: {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "error",
          error: `The user aborted this request.`,
        },
      },
    };
  }

  async requestDefinition() {
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
      const definitionResult = await lsp.requestDefinition(buffer, symbolPos);

      // Helper function to extract location info from different LSP response formats
      const extractLocationInfo = (def: {
        uri?: string;
        range?: LspRange;
        targetUri?: string;
        targetRange?: LspRange;
      }): {
        uri: string;
        range: LspRange;
      } | null => {
        if ("uri" in def && def.uri && "range" in def && def.range) {
          return { uri: def.uri, range: def.range };
        }
        if (
          "targetUri" in def &&
          def.targetUri &&
          "targetRange" in def &&
          def.targetRange
        ) {
          return { uri: def.targetUri, range: def.targetRange };
        }
        return null;
      };

      const definitions = definitionResult
        .filter((result) => result != null)
        .flatMap((result) => result.result)
        .filter((def): def is NonNullable<typeof def> => def != null)
        .map(extractLocationInfo)
        .filter((loc): loc is NonNullable<typeof loc> => loc !== null);

      if (definitions.length === 0) {
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `No definition found for symbol "${this.request.input.symbol}".`,
              },
            ],
          },
        });
        return;
      }

      // Fetch the source code for each definition
      const results: string[] = [];

      for (const def of definitions) {
        const absolutePath = def.uri.replace(/^file:\/\//, "");
        let displayPath = absolutePath;

        if (this.context.cwd) {
          const relativePath = path.relative(this.context.cwd, absolutePath);
          displayPath = relativePath.startsWith("../")
            ? absolutePath
            : relativePath;
        }

        const startLine = def.range.start.line;
        const endLine = def.range.end.line;

        try {
          // Read the file content
          const fileContent = await fs.readFile(absolutePath, "utf-8");
          const lines = fileContent.split("\n");

          // Extract lines around the definition with some context
          const contextLines = 20;
          const extractStart = Math.max(0, startLine - 2);
          const extractEnd = Math.min(lines.length, endLine + contextLines + 1);
          const extractedLines = lines.slice(extractStart, extractEnd);

          const lineNumbers = extractedLines.map(
            (line, i) => `${extractStart + i + 1}: ${line}`,
          );

          results.push(
            `## Definition at ${displayPath}:${startLine + 1}:${def.range.start.character + 1}\n\n\`\`\`\n${lineNumbers.join("\n")}\n\`\`\``,
          );
        } catch (readError) {
          // If we can't read the file, just report the location
          results.push(
            `## Definition at ${displayPath}:${startLine + 1}:${def.range.start.character + 1}\n\n(Unable to read file content: ${readError instanceof Error ? readError.message : String(readError)})`,
          );
        }
      }

      this.context.myDispatch({
        type: "finish",
        result: {
          status: "ok",
          value: [{ type: "text", text: results.join("\n\n") }],
        },
      });
    } catch (error) {
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `Error requesting definition: ${(error as Error).message}`,
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
        return d`🔍⚙️ ${withInlineCode(d`\`${this.request.input.symbol}\``)} in ${withInlineCode(d`\`${this.request.input.filePath}\``)}`;
      case "done":
        if (this.state.result.result.status === "error") {
          return d`🔍❌ ${withInlineCode(d`\`${this.request.input.symbol}\``)} in ${withInlineCode(d`\`${this.request.input.filePath}\``)}`;
        } else {
          return d`🔍✅ ${withInlineCode(d`\`${this.request.input.symbol}\``)} in ${withInlineCode(d`\`${this.request.input.filePath}\``)}`;
        }
      default:
        assertUnreachable(this.state);
    }
  }
}

export const spec: ProviderToolSpec = {
  name: "goto_definition" as ToolName,
  description:
    "Go to the definition of a symbol and retrieve its source code. This is useful for understanding how a function, class, or variable is implemented, especially for symbols defined in external packages or node_modules.",
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file containing the symbol.",
      },
      symbol: {
        type: "string",
        description: `The symbol to find the definition for.
We will use the first occurrence of the complete symbol, so if the symbol is Transport, we will find the definition for the first instance of "Transport", but not "AutoTransport".`,
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
