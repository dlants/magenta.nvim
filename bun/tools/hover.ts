import * as Anthropic from "@anthropic-ai/sdk";
import { type Thunk, type Update } from "../tea/tea.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type ToolRequestId } from "./toolManager.ts";
import { type Result } from "../utils/result.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { getOrOpenBuffer } from "../utils/buffers.ts";
import type { NvimBuffer } from "../nvim/buffer.ts";
import type { Nvim } from "bunvim";
import type { Lsp } from "../lsp.ts";
import { calculateStringPosition } from "../tea/util.ts";
import type { PositionString, StringIdx } from "../nvim/window.ts";

export type Model = {
  type: "hover";
  request: HoverToolUseRequest;
  state:
    | {
        state: "processing";
      }
    | {
        state: "done";
        result: Anthropic.Anthropic.ToolResultBlockParam;
      };
};

export type Msg = {
  type: "finish";
  result: Anthropic.Anthropic.ToolResultBlockParam;
};

export const update: Update<Msg, Model> = (msg, model) => {
  switch (msg.type) {
    case "finish":
      return [
        {
          ...model,
          state: {
            state: "done",
            result: msg.result,
          },
        },
      ];
    default:
      assertUnreachable(msg.type);
  }
};

export function initModel(
  request: HoverToolUseRequest,
  context: {
    nvim: Nvim;
    lsp: Lsp;
  },
): [Model, Thunk<Msg>] {
  const model: Model = {
    type: "hover",
    request,
    state: {
      state: "processing",
    },
  };
  return [
    model,
    async (dispatch) => {
      const { lsp } = context;
      const filePath = model.request.input.filePath;
      const bufferResult = await getOrOpenBuffer({
        relativePath: filePath,
        context,
      });

      let buffer: NvimBuffer;
      let bufferContent: string;
      if (bufferResult.status == "ok") {
        bufferContent = bufferResult.result;
        buffer = bufferResult.buffer;
      } else {
        dispatch({
          type: "finish",
          result: {
            type: "tool_result",
            tool_use_id: model.request.id,
            content: bufferResult.error,
            is_error: true,
          },
        });
        return;
      }

      const symbolStart = bufferContent.indexOf(
        model.request.input.symbol,
      ) as StringIdx;
      if (symbolStart === -1) {
        dispatch({
          type: "finish",
          result: {
            type: "tool_result",
            tool_use_id: model.request.id,
            content: `Symbol "${model.request.input.symbol}" not found in file.`,
            is_error: true,
          },
        });
        return;
      }

      const symbolPos = calculateStringPosition(
        { row: 0, col: 0 } as PositionString,
        bufferContent,
        (symbolStart + model.request.input.symbol.length - 1) as StringIdx,
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
            type: "tool_result",
            tool_use_id: model.request.id,
            content,
          },
        });
      } catch (error) {
        dispatch({
          type: "finish",
          result: {
            type: "tool_result",
            tool_use_id: request.id,
            content: `Error requesting hover: ${(error as Error).message}`,
          },
        });
      }
    },
  ];
}

export function view({ model }: { model: Model }): VDOMNode {
  switch (model.state.state) {
    case "processing":
      return d`⚙️ Requesting hover info...`;
    case "done":
      return d`✅ Hover request complete.`;
    default:
      assertUnreachable(model.state);
  }
}

export function getToolResult(
  model: Model,
): Anthropic.Anthropic.ToolResultBlockParam {
  switch (model.state.state) {
    case "processing":
      return {
        type: "tool_result",
        tool_use_id: model.request.id,
        content: `This tool use is being processed.`,
      };
    case "done":
      return model.state.result;
    default:
      assertUnreachable(model.state);
  }
}

export const spec: Anthropic.Anthropic.Tool = {
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
  },
};

export type HoverToolUseRequest = {
  type: "tool_use";
  id: ToolRequestId;
  input: {
    filePath: string;
    symbol: string;
  };
  name: "hover";
};

export function displayRequest(request: HoverToolUseRequest) {
  return `hover: { filePath: "${request.input.filePath}", symbol: "${request.input.symbol}" }`;
}

export function validateToolRequest(req: unknown): Result<HoverToolUseRequest> {
  if (typeof req != "object" || req == null) {
    return { status: "error", error: "received a non-object" };
  }

  const req2 = req as { [key: string]: unknown };

  if (req2.type != "tool_use") {
    return { status: "error", error: "expected req.type to be tool_use" };
  }

  if (typeof req2.id != "string") {
    return { status: "error", error: "expected req.id to be a string" };
  }

  if (req2.name != "hover") {
    return { status: "error", error: "expected req.name to be hover" };
  }

  if (typeof req2.input != "object" || req2.input == null) {
    return { status: "error", error: "expected req.input to be an object" };
  }

  const input = req2.input as { [key: string]: unknown };

  if (typeof input.filePath != "string") {
    return { status: "error", error: "expected input.filePath to be a string" };
  }

  if (typeof input.symbol != "string") {
    return { status: "error", error: "expected input.symbol to be a string" };
  }

  return {
    status: "ok",
    value: req as HoverToolUseRequest,
  };
}
