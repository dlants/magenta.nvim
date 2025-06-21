import { d } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { StaticTool, ToolName } from "./types.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import type { ThreadId } from "../chat/thread.ts";

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

  constructor(
    public request: Extract<StaticToolRequest, { toolName: "yield_to_parent" }>,
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

  abort() {}

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

  view() {
    switch (this.state.state) {
      case "done": {
        const result = this.state.result.result;
        if (result.status === "error") {
          return d`❌ Error yielding to parent: ${result.error}`;
        } else {
          return d`↗️ yielded`;
        }
      }
    }
  }

  displayInput(): string {
    const input = this.request.input;
    return `yield_to_parent: {
    result: "${input.result}"
}`;
  }
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
    additionalProperties: false,
  },
};

export type Input = {
  result: string;
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
