import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
} from "../agent/provider-types.ts";
import type { StaticTool, ToolName, ToolMsg } from "./types.ts";
import type { ToolRequest, Input } from "./specs/edl.ts";
import type { FileIO as EnvironmentFileIO } from "./environment.ts";
import type { FileIO as EdlFileIO } from "../edl/file-io.ts";
import {
  runScript,
  type EdlRegisters,
  type EdlResultData,
} from "../edl/index.ts";
import type { Logger } from "../logger.ts";
import type { Cwd, HomeDir } from "../utils/files.ts";
import { resolveFilePath } from "../utils/files.ts";
import type { Dispatch } from "../tea/tea.ts";

export type State =
  | { state: "processing" }
  | { state: "done"; result: ProviderToolResult };

export type Msg = {
  type: "finish";
  result: Result<ProviderToolResultContent[]>;
};

export type EdlToolContext = {
  fileIO: EnvironmentFileIO;
  logger: Logger;
  cwd: Cwd;
  homeDir: HomeDir;
  myDispatch: Dispatch<Msg>;
  edlRegisters: EdlRegisters;
};

/** Adapts the environment's FileIO (AbsFilePath + Result) to the EDL engine's
 * FileIO interface (plain strings, throws on error).
 */
function createEdlFileIO(ctx: {
  fileIO: EnvironmentFileIO;
  cwd: Cwd;
  homeDir: HomeDir;
}): EdlFileIO {
  const resolve = (p: string) => resolveFilePath(ctx.cwd, p, ctx.homeDir);

  return {
    async readFile(path: string): Promise<string> {
      const result = await ctx.fileIO.readFile(resolve(path));
      if (result.status === "error") throw new Error(result.error);
      return result.value;
    },
    async writeFile(path: string, content: string): Promise<void> {
      const result = await ctx.fileIO.writeFile(resolve(path), content);
      if (result.status === "error") throw new Error(result.error);
    },
    async fileExists(path: string): Promise<boolean> {
      const result = await ctx.fileIO.fileExists(resolve(path));
      if (result.status === "error") throw new Error(result.error);
      return result.value;
    },
    async mkdir(path: string): Promise<void> {
      const result = await ctx.fileIO.mkdir(resolve(path));
      if (result.status === "error") throw new Error(result.error);
    },
  };
}

export class EdlTool implements StaticTool {
  state: State;
  toolName = "edl" as unknown as ToolName;
  aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public context: EdlToolContext,
  ) {
    this.state = { state: "processing" };

    setTimeout(() => {
      this.executeScript().catch((error) => {
        this.context.logger.error(
          `Error executing EDL script: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
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

    this.state = { state: "done", result };
    return result;
  }

  update(msg: ToolMsg) {
    const m = msg as unknown as Msg;
    switch (m.type) {
      case "finish":
        if (this.state.state === "processing") {
          this.state = {
            state: "done",
            result: {
              type: "tool_result",
              id: this.request.id,
              result: m.result,
            },
          };
        }
        return;

      default:
        assertUnreachable(m as never);
    }
  }

  private async executeScript() {
    try {
      const script = this.request.input.script;
      const edlFileIO = createEdlFileIO(this.context);
      const result = await runScript(
        script,
        edlFileIO,
        this.context.edlRegisters,
      );

      if (this.aborted) return;

      if (result.status === "ok") {
        this.context.edlRegisters.registers = result.edlRegisters.registers;
        this.context.edlRegisters.nextSavedId = result.edlRegisters.nextSavedId;

        this.context.myDispatch({
          type: "finish",
          result: {
            status: "ok",
            value: [
              { type: "text", text: result.formatted },
              {
                type: "text",
                text: `\n\n__EDL_DATA__${JSON.stringify(result.data)}`,
              },
            ],
          },
        });
      } else {
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: result.error,
          },
        });
      }
    } catch (error) {
      if (this.aborted) return;
      this.context.myDispatch({
        type: "finish",
        result: {
          status: "error",
          error: `Failed to execute EDL script: ${(error as Error).message}`,
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
                text: "This tool use is being processed. Please proceed with your answer or address other parts of the question.",
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
}

export function extractEdlData(
  result: ProviderToolResult,
): EdlResultData | undefined {
  if (result.result.status !== "ok") return undefined;
  const content = result.result.value;
  for (const item of content) {
    if (item.type === "text" && item.text.startsWith("\n\n__EDL_DATA__")) {
      try {
        return JSON.parse(
          item.text.slice("\n\n__EDL_DATA__".length),
        ) as EdlResultData;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
