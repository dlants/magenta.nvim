import fs from "fs";
import path from "path";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d } from "../tea/view.ts";
import type { Result } from "../utils/result.ts";

import { getcwd } from "../nvim/nvim.ts";
import type { Nvim } from "../nvim/nvim-node";
import { readGitignore } from "./util.ts";
import type { StaticToolRequest } from "./toolManager.ts";
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

export class ListDirectoryTool implements StaticTool {
  state: State;
  toolName = "list_directory" as const;
  autoRespond = true;

  constructor(
    public request: Extract<StaticToolRequest, { toolName: "list_directory" }>,
    public context: { nvim: Nvim; myDispatch: (msg: Msg) => void },
  ) {
    this.state = {
      state: "processing",
    };
    this.listDirectory().catch((error) => {
      this.context.nvim.logger?.error(
        `Error listing directory: ${error instanceof Error ? error.message : String(error)}`,
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

  async listDirectory() {
    try {
      const cwd = await getcwd(this.context.nvim);
      const dirPath = this.request.input.dirPath || ".";
      const absolutePath = path.resolve(cwd, dirPath);

      if (!absolutePath.startsWith(cwd)) {
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: `The path \`${absolutePath}\` must be inside of neovim cwd \`${cwd}\``,
          },
        });
        return;
      }

      const files = await listDirectoryBFS(absolutePath, cwd);
      this.context.nvim.logger?.debug(`files: ${files.join("\n")}`);
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "ok",
          value: [{ type: "text", text: files.join("\n") }],
        },
      });
    } catch (error) {
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `Failed to list directory: ${(error as Error).message}`,
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
        return d`📁⚙️ list_directory ${this.request.input.dirPath || "."}`;
      case "done": {
        const result = this.state.result.result;
        if (result.status === "error") {
          return d`📁❌ list_directory ${this.request.input.dirPath || "."}`;
        } else {
          return d`📁✅ list_directory ${this.request.input.dirPath || "."}`;
        }
      }
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
  name: "list_directory" as ToolName,
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
