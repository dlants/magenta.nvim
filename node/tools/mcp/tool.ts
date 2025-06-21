import type { Result } from "../../utils/result.ts";
import type { Dispatch, Thunk } from "../../tea/tea.ts";
import type { ProviderToolResult } from "../../providers/provider.ts";
import { d } from "../../tea/view.ts";
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
      this.executeMCPTool().catch((err: Error) =>
        this.context.myDispatch({
          type: "error",
          error: err.message + "\n" + err.stack,
        }),
      );
    });
  }

  isDone(): boolean {
    return this.state.state == "done" || this.state.state == "error";
  }

  update(msg: Msg): Thunk<Msg> | undefined {
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

  /** It is the expectation that this is happening as part of a dispatch, so it should not trigger
   * new dispatches...
   */
  abort(): void {
    if (this.state.state === "processing") {
      this.state = {
        state: "done",
        result: {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "error",
            error: "MCP tool execution was aborted",
          },
        },
      };
    }
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

  view() {
    const { state } = this;

    if (state.state === "processing") {
      const runningTime = Math.floor((Date.now() - state.startTime) / 1000);
      return d`🔨⏳ (${String(runningTime)}s) MCP tool \`${this.toolName}\` running...`;
    }

    if (state.state === "done") {
      return d`🔨✅ MCP tool \`${this.toolName}\` completed`;
    }

    if (state.state === "error") {
      return d`🔨❌ MCP tool \`${this.toolName}\` error: ${state.error}`;
    }

    return d``;
  }

  displayInput(): string {
    return `${this.toolName}: ${JSON.stringify(this.request.input, null, 2)}`;
  }
}
