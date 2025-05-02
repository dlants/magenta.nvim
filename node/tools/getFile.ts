import { getBufferIfOpen } from "../utils/buffers.ts";
import fs from "fs";
import path from "path";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, withBindings } from "../tea/view.ts";
import { type ToolRequest } from "./toolManager.ts";
import { type Result } from "../utils/result.ts";
import { getcwd } from "../nvim/nvim.ts";
import type { Nvim } from "nvim-node";
import { readGitignore } from "./util.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Dispatch, Thunk } from "../tea/tea.ts";

export type State =
  | {
      state: "processing";
      approved: boolean;
    }
  | {
      state: "pending-user-action";
    }
  | {
      state: "done";
      result: ProviderToolResultContent;
    };

export type Msg =
  | {
      type: "finish";
      result: Result<string>;
    }
  | {
      type: "request-user-approval";
    }
  | {
      type: "user-approval";
      approved: boolean;
    };

export class GetFileTool {
  state: State;
  toolName = "get_file" as const;

  private constructor(
    public request: Extract<ToolRequest, { toolName: "get_file" }>,
    public context: { nvim: Nvim },
  ) {
    this.state = {
      state: "processing",
      approved: false,
    };
  }

  static create(
    request: Extract<ToolRequest, { toolName: "get_file" }>,
    context: { nvim: Nvim },
  ): [GetFileTool, Thunk<Msg>] {
    const tool = new GetFileTool(request, context);
    return [tool, tool.readFileThunk()];
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
      case "request-user-approval":
        this.state = {
          state: "pending-user-action",
        };
        return;
      case "user-approval": {
        if (this.state.state === "pending-user-action") {
          if (msg.approved) {
            this.state = {
              state: "processing",
              approved: true,
            };

            return this.readFileThunk();
          } else {
            this.state = {
              state: "done",
              result: {
                type: "tool_result",
                id: this.request.id,
                result: {
                  status: "error",
                  error: `The user did not allow the reading of this file.`,
                },
              },
            };
            return;
          }
        } else {
          throw new Error(
            `Unexpected message ${msg.type} when model state is ${this.state.state}`,
          );
        }
      }
      default:
        assertUnreachable(msg);
    }
  }

  readFileThunk(): Thunk<Msg> {
    return async (dispatch: Dispatch<Msg>) => {
      const filePath = this.request.input.filePath;
      const cwd = await getcwd(this.context.nvim);
      const absolutePath = path.resolve(cwd, filePath);
      const relativePath = path.relative(cwd, absolutePath);

      if (!(this.state.state === "processing" && this.state.approved)) {
        if (!absolutePath.startsWith(cwd)) {
          dispatch({ type: "request-user-approval" });
          return;
        }

        if (relativePath.split(path.sep).some((part) => part.startsWith("."))) {
          dispatch({ type: "request-user-approval" });
          return;
        }

        const ig = await readGitignore(cwd);
        if (ig.ignores(relativePath)) {
          dispatch({ type: "request-user-approval" });
          return;
        }
      }

      const bufferContents = await getBufferIfOpen({
        relativePath: filePath,
        context: this.context,
      });

      if (bufferContents.status === "ok") {
        dispatch({
          type: "finish",
          result: {
            status: "ok",
            value: (
              await bufferContents.buffer.getLines({ start: 0, end: -1 })
            ).join("\n"),
          },
        });
        return;
      }

      if (bufferContents.status === "error") {
        dispatch({
          type: "finish",
          result: {
            status: "error",
            error: bufferContents.error,
          },
        });
        return;
      }

      try {
        const fileContent = await fs.promises.readFile(absolutePath, "utf-8");
        dispatch({
          type: "finish",
          result: {
            status: "ok",
            value: fileContent,
          },
        });
        return;
      } catch (error) {
        dispatch({
          type: "finish",
          result: {
            status: "error",
            error: `Failed to read file: ${(error as Error).message}`,
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
            value: `This tool use is being processed. Please proceed with your answer or address other parts of the question.`,
          },
        };
      case "pending-user-action":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: `Waiting for user approval to finish processing this tool use.`,
          },
        };
      case "done":
        return this.state.result;
      default:
        assertUnreachable(this.state);
    }
  }

  view(dispatch: Dispatch<Msg>) {
    switch (this.state.state) {
      case "processing":
        return d`⚙️ Reading file ${this.request.input.filePath}`;
      case "pending-user-action":
        return d`⏳ May I read file \`${this.request.input.filePath}\`? ${withBindings(
          d`**[ NO ]**`,
          {
            "<CR>": () => dispatch({ type: "user-approval", approved: false }),
          },
        )} ${withBindings(d`**[ OK ]**`, {
          "<CR>": () => dispatch({ type: "user-approval", approved: true }),
        })}`;
      case "done":
        if (this.state.result.result.status == "error") {
          return d`❌ Error reading file \`${this.request.input.filePath}\`: ${this.state.result.result.error}`;
        } else {
          return d`✅ Finished reading file \`${this.request.input.filePath}\``;
        }
      default:
        assertUnreachable(this.state);
    }
  }

  displayInput() {
    return `get_file: {
    filePath: ${this.request.input.filePath}
}`;
  }
}

export const spec: ProviderToolSpec = {
  name: "get_file",
  description: `Get the full contents of a file in the project directory.`,
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description:
          "the path, relative to the project root, of the file. e.g. ./src/index.ts",
      },
    },
    required: ["filePath"],
    additionalProperties: false,
  },
};

export type Input = {
  filePath: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.filePath != "string") {
    return {
      status: "error",
      error: "expected req.input.filePath to be a string",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
