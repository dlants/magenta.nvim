import fs from "fs";
import path from "path";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d } from "../tea/view.ts";
import type { Result } from "../utils/result.ts";
import type { Dispatch, Thunk } from "../tea/tea.ts";
import { getcwd } from "../nvim/nvim.ts";
import type { Nvim } from "nvim-node";
import { readGitignore } from "./util.ts";
import type { ToolRequest } from "./toolManager.ts";
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

async function listDirectoryBFS(
  startPath: string,
  cwd: string,
): Promise<string[]> {
  const ig = await readGitignore(cwd);
  const queue: string[] = [startPath];
  const results: string[] = [];
  const seen = new Set<string>();

  while (queue.length > 0 && results.length < 100) {
    const currentPath = queue.shift()!;

    const entries = await fs.promises.readdir(currentPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(cwd, fullPath);

      // Skip hidden files and respected gitignored files
      if (entry.name.startsWith(".") || ig.ignores(relativePath)) {
        continue;
      }

      if (!fullPath.startsWith(cwd)) {
        continue;
      }

      if (!seen.has(fullPath)) {
        seen.add(fullPath);

        if (entry.isDirectory()) {
          results.push(relativePath + "/");
          queue.push(fullPath);
        } else {
          results.push(relativePath);
        }
      }
    }
  }

  return results;
}

export class ListDirectoryTool {
  state: State;
  toolName = "list_directory" as const;
  autoRespond = true;

  private constructor(
    public request: Extract<ToolRequest, { toolName: "list_directory" }>,
    public context: { nvim: Nvim },
  ) {
    this.state = {
      state: "processing",
    };
  }

  static create(
    request: Extract<ToolRequest, { toolName: "list_directory" }>,
    context: { nvim: Nvim },
  ): [ListDirectoryTool, Thunk<Msg>] {
    const tool = new ListDirectoryTool(request, context);
    return [tool, tool.listDirectory()];
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

  listDirectory(): Thunk<Msg> {
    return async (dispatch: Dispatch<Msg>) => {
      try {
        const cwd = await getcwd(this.context.nvim);
        const dirPath = this.request.input.dirPath || ".";
        const absolutePath = path.resolve(cwd, dirPath);

        if (!absolutePath.startsWith(cwd)) {
          dispatch({
            type: "finish",
            result: {
              status: "error",
              error: "The path must be inside of neovim cwd",
            },
          });
          return;
        }

        const files = await listDirectoryBFS(absolutePath, cwd);
        this.context.nvim.logger?.debug(`files: ${files.join("\n")}`);
        dispatch({
          type: "finish",
          result: {
            status: "ok",
            value: files.join("\n"),
          },
        });
      } catch (error) {
        dispatch({
          type: "finish",
          result: {
            status: "error",
            error: `Failed to list directory: ${(error as Error).message}`,
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
      case "done":
        return this.state.result;
      default:
        assertUnreachable(this.state);
    }
  }

  view() {
    switch (this.state.state) {
      case "processing":
        return d`⚙️ Listing directory ${this.request.input.dirPath || "."}`;
      case "done":
        return d`✅ Finished listing directory ${this.request.input.dirPath || "."}`;
      default:
        assertUnreachable(this.state);
    }
  }

  displayInput() {
    return `list_directory: {
    dirPath: ${this.request.input.dirPath || "."}
}`;
  }
}

export const spec: ProviderToolSpec = {
  name: "list_directory",
  description: `List up to 100 files in a directory using breadth-first search, respecting .gitignore and hidden files.`,
  input_schema: {
    type: "object",
    properties: {
      dirPath: {
        type: "string",
        description: `The directory path relative to cwd. Use "." to list whole directory.`,
      },
    },
    required: ["dirPath"],
    additionalProperties: false,
  },
};

export type Input = {
  dirPath?: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (input.dirPath !== undefined && typeof input.dirPath !== "string") {
    return {
      status: "error",
      error: "expected req.input.dirPath to be a string if provided",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
