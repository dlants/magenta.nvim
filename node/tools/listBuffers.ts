import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d } from "../tea/view.ts";
import { type StaticToolRequest } from "./toolManager.ts";
import { type Result } from "../utils/result.ts";
import type { Nvim } from "../nvim/nvim-node";
import { parseLsResponse } from "../utils/lsBuffers.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
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

export class ListBuffersTool implements StaticTool {
  state: State;
  toolName = "list_buffers" as const;

  constructor(
    public request: Extract<StaticToolRequest, { toolName: "list_buffers" }>,
    public context: { nvim: Nvim; myDispatch: (msg: Msg) => void },
  ) {
    this.state = {
      state: "processing",
    };
    this.fetchBuffers().catch((error) => {
      this.context.nvim.logger?.error(
        `Error fetching buffers: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
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
          error: "The user aborted this tool request.",
        },
      },
    };
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

  async fetchBuffers() {
    const lsResponse = await this.context.nvim.call("nvim_exec2", [
      "ls",
      { output: true },
    ]);

    const result = parseLsResponse(lsResponse.output as string);
    const content = result
      .map((bufEntry) => {
        let out = "";
        if (bufEntry.flags.active) {
          out += "active ";
        }
        if (bufEntry.flags.modified) {
          out += "modified ";
        }
        if (bufEntry.flags.terminal) {
          out += "terminal ";
        }
        out += bufEntry.filePath;
        return out;
      })
      .join("\n");

    this.context.myDispatch({
      type: "finish",
      result: {
        status: "ok",
        value: [{ type: "text", text: content }],
      },
    });
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

  view() {
    switch (this.state.state) {
      case "processing":
        return d`⚙️ Grabbing buffers...`;
      case "done":
        return d`✅ Finished getting buffers.`;
      default:
        assertUnreachable(this.state);
    }
  }

  displayInput() {
    return `list_buffers: {}`;
  }
}

export const spec: ProviderToolSpec = {
  name: "list_buffers" as ToolName,
  description: `List all the buffers the user currently has open.
This will be similar to the output of :buffers in neovim, so buffers will be listed in the order they were opened, with the most recent buffers last.
This can be useful to understand the context of what the user is trying to do.`,
  input_schema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type Input = {};

export function validateInput(): Result<Input> {
  return {
    status: "ok",
    value: {} as Input,
  };
}
