import type { Result } from "../../utils/result.ts";
import type { Dispatch } from "../../tea/tea.ts";
import type { ProviderToolResult } from "../../providers/provider.ts";
import { d, withInlineCode } from "../../tea/view.ts";
import type { Nvim } from "../../nvim/nvim-node";
import { assertUnreachable } from "../../utils/assertUnreachable.ts";
import type { Tool, ToolName, ToolRequestId } from "../types.ts";
import type { MCPClient } from "./client.ts";
import { parseToolName, type MCPToolRequestParams } from "./types.ts";

export type Input = {
  [key: string]: unknown;
};

type State =
  | {
      state: "processing";
      startTime: number;
    }
  | {
      state: "done";
      result: ProviderToolResult;
    }
  | {
      state: "error";
      error: string;
    };

export type Msg =
  | { type: "success"; result: ProviderToolResult }
  | { type: "error"; error: string };

export function validateInput(args: { [key: string]: unknown }): Result<Input> {
  // MCP tools will validate for us upon tool call, so we can just pass this through.
  return {
    status: "ok",
    value: args,
  };
}

export class MCPTool implements Tool {
  state: State;
  toolName: ToolName;
  aborted: boolean = false;

  constructor(
    public request: {
      id: ToolRequestId;
      toolName: ToolName;
      input: Input;
    },
    public context: {
      nvim: Nvim;
      mcpClient: MCPClient;
      myDispatch: Dispatch<Msg>;
    },
  ) {
    this.toolName = request.toolName;
    this.state = {
      state: "processing",
      startTime: Date.now(),
    };

    // Start the MCP tool execution in a fresh frame
    setTimeout(() => {
      if (this.aborted) return;
      this.executeMCPTool().catch((err: Error) => {
        if (this.aborted) return;
        this.context.myDispatch({
          type: "error",
          error: err.message + "\n" + err.stack,
        });
      });
    });
  }

  isDone(): boolean {
    return this.state.state == "done" || this.state.state == "error";
  }

  isPendingUserAction(): boolean {
    return false; // MCP tools never require user action
  }

  update(msg: Msg): void {
    if (this.state.state === "done" || this.state.state === "error") {
      return;
    }

    switch (msg.type) {
      case "success": {
        if (this.state.state !== "processing") {
          return;
        }

        this.state = {
          state: "done",
          result: msg.result,
        };
        return;
      }

      case "error": {
        this.state = {
          state: "error",
          error: msg.error,
        };
        return;
      }

      default:
        assertUnreachable(msg);
    }
  }

  async executeMCPTool(): Promise<void> {
    try {
      const mcpToolName = parseToolName(this.request.toolName).mcpToolName;
      const params = this.request.input as MCPToolRequestParams;

      const result = await this.context.mcpClient.callTool(mcpToolName, params);

      if (this.aborted) return;

      this.context.myDispatch({
        type: "success",
        result: {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: result,
          },
        },
      });
    } catch (error) {
      if (this.aborted) return;

      const errorMessage =
        error instanceof Error
          ? error.message + "\n" + error.stack
          : String(error);

      this.context.myDispatch({
        type: "error",
        error: errorMessage,
      });
    }
  }

  abort(): ProviderToolResult {
    if (this.state.state === "done" || this.state.state === "error") {
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

  getToolResult(): ProviderToolResult {
    const { state } = this;

    switch (state.state) {
      case "done": {
        return state.result;
      }

      case "error":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "error",
            error: `MCP tool error: ${state.error}`,
          },
        };

      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [{ type: "text", text: "MCP tool still running" }],
          },
        };

      default:
        assertUnreachable(state);
    }
  }

  renderSummary() {
    const { state } = this;

    if (state.state === "processing") {
      const runningTime = Math.floor((Date.now() - state.startTime) / 1000);
      return d`🔨⚙️ (${String(runningTime)}s) MCP tool ${withInlineCode(d`\`${this.toolName}\``)}`;
    }

    if (state.state === "done") {
      return d`🔨✅ MCP tool ${withInlineCode(d`\`${this.toolName}\``)}`;
    }

    if (state.state === "error") {
      return d`🔨❌ MCP tool ${withInlineCode(d`\`${this.toolName}\``)}`;
    }

    return d``;
  }
}
