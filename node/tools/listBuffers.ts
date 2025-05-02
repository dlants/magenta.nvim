import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d } from "../tea/view.ts";
import { type ToolRequest } from "./toolManager.ts";
import { type Result } from "../utils/result.ts";
import type { Dispatch, Thunk } from "../tea/tea.ts";
import type { Nvim } from "nvim-node";
import { parseLsResponse } from "../utils/lsBuffers.ts";
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

export class ListBuffersTool {
  state: State;
  toolName = "list_buffers" as const;

  constructor(
    public request: Extract<ToolRequest, { toolName: "list_buffers" }>,
    public context: { nvim: Nvim },
  ) {
    this.state = {
      state: "processing",
    };
  }
  static create(
    request: Extract<ToolRequest, { toolName: "list_buffers" }>,
    context: { nvim: Nvim },
  ): [ListBuffersTool, Thunk<Msg>] {
    const tool = new ListBuffersTool(request, context);
    return [tool, tool.fetchBuffers()];
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

  fetchBuffers(): Thunk<Msg> {
    return async (dispatch: Dispatch<Msg>) => {
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

      dispatch({
        type: "finish",
        result: {
          status: "ok",
          value: content,
        },
      });
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
            value: `This tool use is being processed. Please proceed with your answer or address other parts of the question.`,
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
  name: "list_buffers",
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
