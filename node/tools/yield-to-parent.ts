import { d } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { ToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { ToolInterface } from "./types.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import type { ThreadId } from "../chat/thread.ts";
import type { ToolRequestId } from "./toolManager.ts";

export type Msg = {
  type: "finish";
  result: Result<string>;
};

export type State = {
  state: "done";
  result: ProviderToolResultContent;
};

export class YieldToParentTool implements ToolInterface {
  toolName = "yield_to_parent" as const;
  public state: State;

  constructor(
    public request: Extract<ToolRequest, { toolName: "yield_to_parent" }>,
    public context: {
      nvim: Nvim;
      dispatch: Dispatch<RootMsg>;
      threadId: ThreadId;
      myDispatch: Dispatch<Msg>;
      parent?: {
        threadId: ThreadId;
        toolRequestId: ToolRequestId;
      };
    },
  ) {
    this.state = {
      state: "done",
      result: {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "ok",
          value: request.input.result,
        },
      },
    };
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

  getToolResult(): ProviderToolResultContent {
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
          return d`↗️ Successfully yielded result to parent thread`;
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
  name: "yield_to_parent",
  description: `This tool allows a sub-agent to yield results back to its parent agent.
This tool should only be used when the sub-agent has completed its assigned task and needs to return results.
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
