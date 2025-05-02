import { d } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { Dispatch, Thunk } from "../tea/tea.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getOrOpenBuffer } from "../utils/buffers.ts";
import type { NvimBuffer } from "../nvim/buffer.ts";
import type { Nvim } from "nvim-node";
import type { Lsp } from "../lsp.ts";
import { calculateStringPosition } from "../tea/util.ts";
import type { PositionString, StringIdx } from "../nvim/window.ts";
import type { ToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";

export type State =
  | {
      state: "processing";
    }
  | {
      state: "done";
      result: ProviderToolResultContent;
    };

export type Msg = {
  type: "finish";
  result: Result<string>;
};

export class HoverTool {
  state: State;
  toolName = "hover" as const;

  private constructor(
    public request: Extract<ToolRequest, { toolName: "hover" }>,
    public context: { nvim: Nvim; lsp: Lsp },
  ) {
    this.state = {
      state: "processing",
    };
  }

  static create(
    request: Extract<ToolRequest, { toolName: "hover" }>,
    context: { nvim: Nvim; lsp: Lsp },
  ): [HoverTool, Thunk<Msg>] {
    const tool = new HoverTool(request, context);
    return [tool, tool.requestHover()];
  }

  update(msg: Msg): Thunk<Msg> | undefined {
    switch (msg.type) {
      case "finish":
        this.state = {
          state: "done",
          result: {
            type: "tool_result",
            id: this.request.id,
            result: msg.result,
          },
        };
        return;
      default:
        assertUnreachable(msg.type);
    }
  }

  requestHover(): Thunk<Msg> {
    return async (dispatch: Dispatch<Msg>) => {
      const { lsp } = this.context;
      const filePath = this.request.input.filePath;
      const bufferResult = await getOrOpenBuffer({
        relativePath: filePath,
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
        dispatch({
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
        dispatch({
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

        dispatch({
          type: "finish",
          result: {
            status: "ok",
            value: content,
          },
        });
      } catch (error) {
        dispatch({
          type: "finish",
          result: {
            status: "error",
            error: `Error requesting hover: ${(error as Error).message}`,
          },
        });
      }
    };
  }

  getToolResult(): ProviderToolResultContent {
    switch (this.state.state) {
      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: `This tool use is being processed.`,
          },
        };
      case "done":
        return this.state.result;
      default:
        assertUnreachable(this.state);
    }
  }

  view() {
    switch (this.state.state) {
      case "processing":
        return d`⚙️ Requesting hover info...`;
      case "done":
        return d`✅ Hover request complete.`;
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
  name: "hover",
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
  filePath: string;
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
