import { d, withInlineCode, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { CompletedToolInfo } from "./types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getOrOpenBuffer } from "../utils/buffers.ts";
import type { NvimBuffer } from "../nvim/buffer.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Lsp } from "../lsp.ts";
import { calculateStringPosition } from "../tea/util.ts";
import type { PositionString, Row0Indexed, StringIdx } from "../nvim/window.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import {
  relativePath,
  type NvimCwd,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import type { StaticTool, ToolName, GenericToolRequest } from "./types.ts";

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

export class FindReferencesTool implements StaticTool {
  state: State;
  toolName = "find_references" as const;
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
    this.findReferences().catch((error) => {
      this.context.nvim.logger.error(
        `Error finding references: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
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

  async findReferences() {
    const { lsp, nvim, cwd } = this.context;
    const filePath = this.request.input.filePath;
    const bufferResult = await getOrOpenBuffer({
      unresolvedPath: filePath,
      context: { nvim, cwd },
    });

    if (this.aborted) return;

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

    if (this.aborted) return;
    const symbolStart = bufferContent.indexOf(
      this.request.input.symbol,
    ) as StringIdx;

    if (symbolStart === -1) {
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `Symbol "${this.request.input.symbol}" not found in file.`,
        },
      });
      return;
    }

    const symbolPos = calculateStringPosition(
      { row: 0, col: 0 } as PositionString,
      bufferContent,
      (symbolStart + this.request.input.symbol.length - 1) as StringIdx,
    );

    try {
      const result = await lsp.requestReferences(buffer, symbolPos);

      if (this.aborted) return;

      let content = "";
      for (const lspResult of result) {
        if (lspResult != null && lspResult.result) {
          for (const ref of lspResult.result) {
            const uri = ref.uri.startsWith("file://")
              ? ref.uri.slice(7)
              : ref.uri;
            const relFilePath = relativePath(
              this.context.cwd,
              uri as UnresolvedFilePath,
            );
            content += `${relFilePath}:${ref.range.start.line + 1}:${ref.range.start.character}\n`;
          }
        }
      }

      this.context.myDispatch({
        type: "finish",
        result: {
          status: "ok",
          value: [{ type: "text", text: content || "No references found" }],
        },
      });
    } catch (error) {
      if (this.aborted) return;

      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `Error requesting references: ${(error as Error).message}`,
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
  return d`🔍${status} ${withInlineCode(d`\`${input.symbol}\``)} in ${withInlineCode(d`\`${input.filePath}\``)}`;
}

export const spec: ProviderToolSpec = {
  name: "find_references" as ToolName,
  description: "Find all references to a symbol in the workspace.",
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file containing the symbol.",
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
