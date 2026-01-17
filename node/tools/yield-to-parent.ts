import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { CompletedToolInfo } from "./types.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { StaticTool, ToolName, GenericToolRequest } from "./types.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import type { ThreadId } from "../chat/types";

export type Input = {
  result: string;
};

export type ToolRequest = GenericToolRequest<"yield_to_parent", Input>;

export type Msg = {
  type: "finish";
  result: Result<string>;
};

export type State = {
  state: "done";
  result: ProviderToolResult;
};

export class YieldToParentTool implements StaticTool {
  toolName = "yield_to_parent" as const;
  public state: State;
  public aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public context: {
      nvim: Nvim;
      dispatch: Dispatch<RootMsg>;
      threadId: ThreadId;
      myDispatch: Dispatch<Msg>;
    },
  ) {
    this.state = {
      state: "done",
      result: {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "ok",
          value: [{ type: "text", text: request.input.result }],
        },
      },
    };
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

  update(msg: Msg): void {
    switch (msg.type) {
      case "finish":
        // Handle finish message if needed
        if (msg.result.status === "ok") {
          // No additional handling needed for successful finish
        } else {
          this.state = {
            state: "done",
            result: {
              type: "tool_result",
              id: this.request.id,
              result: {
                status: "error",
                error: msg.result.error,
              },
            },
          };
        }
        return;
      default:
        // No other message types expected
        return;
    }
  }

  getToolResult(): ProviderToolResult {
    if (this.state.state !== "done") {
      throw new Error("Cannot get tool result before tool is done");
    }
    return this.state.result;
  }

  renderSummary() {
    return renderCompletedSummary({
      request: this.request as CompletedToolInfo["request"],
      result: this.state.result,
    });
  }
}

function isError(result: ProviderToolResult): boolean {
  return result.result.status === "error";
}

function getStatusEmoji(result: ProviderToolResult): string {
  return isError(result) ? "❌" : "✅";
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const status = getStatusEmoji(info.result);
  const resultPreview =
    input.result?.length > 50
      ? input.result.substring(0, 50) + "..."
      : (input.result ?? "");
  return d`↩️${status} yield_to_parent: ${resultPreview}`;
}

export const spec: ProviderToolSpec = {
  name: "yield_to_parent" as ToolName,
  description: `\
Yield results to the parent agent.

CRITICAL: You MUST use this tool when your task is complete, or the parent agent will never receive your results.

Make sure you address every part of the original prompt you were given.
The parent agent can only observe your final yield message - none of the rest of the text is visible to the parent.
After using this tool, the sub-agent thread will be terminated.`,
  input_schema: {
    type: "object",
    properties: {
      result: {
        type: "string",
        description: "The result or information to return to the parent agent",
      },
    },
    required: ["result"],
  },
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.result != "string") {
    return {
      status: "error",
      error: `expected req.input.result to be a string but it was ${JSON.stringify(input.result)}`,
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
