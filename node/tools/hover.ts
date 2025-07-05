import { d } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getOrOpenBuffer } from "../utils/buffers.ts";
import type { NvimBuffer } from "../nvim/buffer.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Lsp } from "../lsp.ts";
import { calculateStringPosition } from "../tea/util.ts";
import type { PositionString, StringIdx } from "../nvim/window.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { StaticTool, ToolName } from "./types.ts";

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

  constructor(
    public request: Extract<StaticToolRequest, { toolName: "hover" }>,
    public context: { nvim: Nvim; lsp: Lsp; myDispatch: (msg: Msg) => void },
  ) {
    this.state = {
      state: "processing",
    };
    this.requestHover().catch((error) => {
      this.context.nvim.logger?.error(
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
        await bufferResult.buffer.getLines({ start: 0, end: -1 })
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
      const result = await lsp.requestHover(buffer, symbolPos);
      let content = "";
      for (const lspResult of result) {
        if (lspResult != null) {
          content += `\
(${lspResult.result.contents.kind}):
${lspResult.result.contents.value}
`;
        }
      }

      this.context.myDispatch({
        type: "finish",
        result: {
          status: "ok",
          value: [{ type: "text", text: content }],
        },
      });
    } catch (error) {
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
        return d`ℹ️⚙️ \`${this.request.input.symbol}\` in \`${this.request.input.filePath}\``;
      case "done":
        if (this.state.result.result.status === "error") {
          return d`ℹ️❌ \`${this.request.input.symbol}\` in \`${this.request.input.filePath}\``;
        } else {
          return d`ℹ️✅ \`${this.request.input.symbol}\` in \`${this.request.input.filePath}\``;
        }
      default:
        assertUnreachable(this.state);
    }
  }

  displayInput() {
    return `hover: {
  filePath: "${this.request.input.filePath}",
  symbol: "${this.request.input.symbol}"
}`;
  }
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
We will use the first occurrence of the symbol.
We will use the right-most character of this string, so if the string is "a.b.c", we will hover c.`,
      },
    },
    required: ["filePath", "symbol"],
    additionalProperties: false,
  },
};

export type Input = {
  filePath: UnresolvedFilePath;
  symbol: string;
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

  return {
    status: "ok",
    value: input as Input,
  };
}
