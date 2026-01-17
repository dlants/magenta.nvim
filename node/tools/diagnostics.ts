import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { CompletedToolInfo } from "./types.ts";
import type { Nvim } from "../nvim/nvim-node";
import { getDiagnostics } from "../utils/diagnostics.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { StaticTool, ToolName, GenericToolRequest } from "./types.ts";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type Input = {};

export type ToolRequest = GenericToolRequest<"diagnostics", Input>;

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

export class DiagnosticsTool implements StaticTool {
  state: State;
  toolName = "diagnostics" as const;
  aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public context: { nvim: Nvim; myDispatch: (msg: Msg) => void },
  ) {
    this.state = {
      state: "processing",
    };
    this.getDiagnostics().catch((error) => {
      this.context.nvim.logger.error(
        `Error getting diagnostics: ${error instanceof Error ? error.message : String(error)}`,
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

  async getDiagnostics() {
    try {
      const content = await getDiagnostics(this.context.nvim);
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
          error: `Failed to get diagnostics: ${error instanceof Error ? error.message : String(error)}`,
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
              {
                type: "text",
                text: `This tool use is being processed. Please proceed with your answer or address other parts of the question.`,
              },
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
        return d`🔍⚙️ diagnostics`;
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
  const result = info.result.result;

  if (result.status === "error") {
    return d`🔍❌ diagnostics - ${result.error}`;
  }

  return d`🔍✅ diagnostics - Diagnostics retrieved`;
}

export const spec: ProviderToolSpec = {
  name: "diagnostics" as ToolName,
  description: "Get all diagnostic messages in the workspace.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export function validateInput(): Result<Input> {
  return {
    status: "ok",
    value: {} as Input,
  };
}
