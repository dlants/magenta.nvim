import type { Result } from "../utils/result.ts";
import type { Dispatch } from "../tea/tea.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import {
  d,
  withBindings,
  withCode,
  withInlineCode,
  withExtmark,
} from "../tea/view.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import type { Nvim } from "../nvim/nvim-node";
import { spawn, spawnSync } from "child_process";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { MagentaOptions } from "../options.ts";
import { withTimeout } from "../utils/async.ts";
import type { StaticTool, ToolName } from "./types.ts";
import { type NvimCwd } from "../utils/files.ts";
import {
  isCommandAllowedByConfig,
  type PermissionCheckResult,
} from "./bash-parser/permissions.ts";
import type { Gitignore } from "./util.ts";

const MAX_OUTPUT_TOKENS_FOR_AGENT = 10000;
const CHARACTERS_PER_TOKEN = 4;

let rgAvailable: boolean | undefined;
let fdAvailable: boolean | undefined;

export function isRgAvailable(): boolean {
  if (rgAvailable === undefined) {
    const result = spawnSync("which", ["rg"], { stdio: "pipe" });
    rgAvailable = result.status === 0;
  }
  return rgAvailable;
}

export function isFdAvailable(): boolean {
  if (fdAvailable === undefined) {
    const result = spawnSync("which", ["fd"], { stdio: "pipe" });
    fdAvailable = result.status === 0;
  }
  return fdAvailable;
}

const BASE_DESCRIPTION = `Run a command in a bash shell.
You will get the stdout and stderr of the command, as well as the exit code.
For example, you can run \`ls\`, \`echo 'Hello, World!'\`, or \`git status\`.
The command will time out after 1 min.
You should not run commands that require user input, such as \`git commit\` without \`-m\` or \`ssh\`.
You should not run commands that do not halt, such as \`docker compose up\` without \`-d\`, \`tail -f\` or \`watch\`.
`;

const RG_DESCRIPTION = `
For searching file contents, prefer \`rg\` (ripgrep) which is available on this system. Examples:
- \`rg "pattern"\` - search recursively in current directory
- \`rg "pattern" path/to/dir\` - search in specific directory
- \`rg "pattern" path/to/file\` - search in specific file
- \`echo "text" | rg "pattern"\` - search in piped input
`;

const FD_DESCRIPTION = `
For finding files by name, prefer \`fd\` which is available on this system. Note: fd skips hidden files and gitignored files by default. Examples:
- \`fd "pattern"\` - find files matching pattern recursively
- \`fd "pattern" path/to/dir\` - find in specific directory
- \`fd -e ts\` - find files with specific extension
- \`fd -t f "pattern"\` - find only files (not directories)
- \`fd -t d "pattern"\` - find only directories
`;

export function getSpec(): ProviderToolSpec {
  let description = BASE_DESCRIPTION;
  if (isRgAvailable()) {
    description += RG_DESCRIPTION;
  }
  if (isFdAvailable()) {
    description += FD_DESCRIPTION;
  }

  return {
    name: "bash_command" as ToolName,
    description,
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command to run in the terminal",
        },
      },
      required: ["command"],
    },
  };
}

export const spec: ProviderToolSpec = getSpec();

export type Input = {
  command: string;
};

type OutputLine = {
  stream: "stdout" | "stderr";
  text: string;
};

type State =
  | {
      state: "processing";
      output: OutputLine[];
      startTime: number;
      approved: boolean;
      childProcess: ReturnType<typeof spawn> | null;
    }
  | {
      state: "pending-user-action";
    }
  | {
      state: "done";
      output: OutputLine[];
      exitCode: number | undefined;
      result: ProviderToolResult;
    }
  | {
      state: "error";
      error: string;
    };

export type Msg =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; error: string }
  | { type: "request-user-approval" }
  | { type: "user-approval"; approved: boolean; remember?: boolean }
  | { type: "terminate" }
  | { type: "tick" };

export function validateInput(args: { [key: string]: unknown }): Result<Input> {
  if (typeof args.command !== "string") {
    return {
      status: "error",
      error: `Expected command to be a string but got ${typeof args.command}`,
    };
  }

  return {
    status: "ok",
    value: {
      command: args.command,
    },
  };
}

/**
 * Check command permissions using the parser-based commandConfig.
 */
export function checkCommandPermissions({
  command,
  options,
  rememberedCommands,
  cwd,
  gitignore,
}: {
  command: string;
  options: MagentaOptions;
  rememberedCommands: Set<string>;
  cwd: NvimCwd;
  gitignore: Gitignore;
}): PermissionCheckResult {
  // First check remembered commands
  if (rememberedCommands.has(command)) {
    return { allowed: true };
  }

  return isCommandAllowedByConfig(command, options.commandConfig, {
    cwd,
    skillsPaths: options.skillsPaths,
    gitignore,
  });
}

export class BashCommandTool implements StaticTool {
  state: State;
  toolName = "bash_command" as const;
  private tickInterval: ReturnType<typeof setInterval> | undefined;

  constructor(
    public request: Extract<StaticToolRequest, { toolName: "bash_command" }>,
    public context: {
      nvim: Nvim;
      cwd: NvimCwd;
      options: MagentaOptions;
      myDispatch: Dispatch<Msg>;
      rememberedCommands: Set<string>;
      getDisplayWidth(): number;
      gitignore: Gitignore;
    },
  ) {
    // Check permissions synchronously
    const permissionResult = checkCommandPermissions({
      command: request.input.command,
      options: this.context.options,
      rememberedCommands: this.context.rememberedCommands,
      cwd: this.context.cwd,
      gitignore: this.context.gitignore,
    });

    if (permissionResult.allowed) {
      this.state = {
        state: "processing",
        output: [],
        startTime: Date.now(),
        approved: true,
        childProcess: null,
      };
      // wrap in setTimeout to force a new eventloop frame, to avoid dispatch-in-dispatch
      setTimeout(() => {
        this.executeCommand().catch((err: Error) =>
          this.context.myDispatch({
            type: "error",
            error: err.message + "\n" + err.stack,
          }),
        );
      });
    } else {
      this.state = {
        state: "pending-user-action",
      };
    }
  }

  update(msg: Msg) {
    if (this.state.state === "done" || this.state.state === "error") {
      return;
    }

    switch (msg.type) {
      case "request-user-approval": {
        if (this.state.state !== "pending-user-action") {
          return;
        }
        return;
      }

      case "user-approval": {
        if (this.state.state !== "pending-user-action") {
          return;
        }

        if (msg.approved) {
          this.state = {
            state: "processing",
            output: [],
            startTime: Date.now(),
            approved: true,
            childProcess: null,
          };

          // wrap in setTimeout to force a new eventloop frame to avoid dispatch-in-dispatch
          setTimeout(() => {
            this.executeCommand().catch((err: Error) =>
              this.context.myDispatch({
                type: "error",
                error: err.message + "\n" + err.stack,
              }),
            );
          });
          return;
        } else {
          this.state = {
            state: "done",
            exitCode: 1,
            output: [],
            result: {
              type: "tool_result",
              id: this.request.id,
              result: {
                status: "error",
                error: `The user did not allow running this command.`,
              },
            },
          };
        }
        return;
      }

      case "stdout": {
        if (this.state.state !== "processing") {
          return;
        }

        if (msg.text.trim() !== "") {
          this.state.output.push({
            stream: "stdout",
            text: msg.text,
          });
        }
        return;
      }

      case "stderr": {
        if (this.state.state !== "processing") {
          return;
        }

        if (msg.text.trim() !== "") {
          this.state.output.push({
            stream: "stderr",
            text: msg.text,
          });
        }
        return;
      }

      case "exit": {
        if (this.state.state !== "processing") {
          return;
        }

        // Process the output array to format with stream markers
        // trim to last N tokens to avoid over-filling the context
        const outputTail = this.trimOutputByTokens(this.state.output);
        let formattedOutput = "";
        let currentStream: "stdout" | "stderr" | null = null;

        for (const line of outputTail) {
          if (currentStream !== line.stream) {
            formattedOutput +=
              line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
            currentStream = line.stream;
          }
          formattedOutput += line.text + "\n";
        }
        formattedOutput += "exit code " + msg.code + "\n";

        this.state = {
          state: "done",
          exitCode: msg.code != undefined ? msg.code : -1,
          output: this.state.output,
          result: {
            type: "tool_result",
            id: this.request.id,
            result: {
              status: "ok",
              value: [{ type: "text", text: formattedOutput }],
            },
          },
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

      case "terminate": {
        this.terminate();
        return;
      }

      case "tick": {
        // Just triggers a re-render to update the timer display
        return;
      }

      default:
        assertUnreachable(msg);
    }
  }

  private terminate() {
    if (this.state.state === "processing" && this.state.childProcess) {
      this.state.childProcess.kill("SIGTERM");
      this.state.output.push({
        stream: "stderr",
        text: "Process terminated by user with SIGTERM",
      });
    }
  }

  private startTickInterval() {
    this.tickInterval = setInterval(() => {
      this.context.myDispatch({ type: "tick" });
    }, 1000);
  }

  private stopTickInterval() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = undefined;
    }
  }

  async executeCommand(): Promise<void> {
    const { command } = this.request.input;

    let childProcess: ReturnType<typeof spawn> | null = null;
    this.startTickInterval();

    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          childProcess = spawn("bash", ["-c", command], {
            stdio: "pipe",
            cwd: this.context.cwd,
          });

          if (this.state.state === "processing") {
            this.state.childProcess = childProcess;
          }

          childProcess.stdout?.on("data", (data: Buffer) => {
            const text = data.toString();
            const lines = text.split("\n");
            for (const line of lines) {
              if (line.trim()) {
                this.context.myDispatch({ type: "stdout", text: line });
              }
            }
          });

          childProcess.stderr?.on("data", (data: Buffer) => {
            const text = data.toString();
            const lines = text.split("\n");
            for (const line of lines) {
              if (line.trim()) {
                this.context.myDispatch({ type: "stderr", text: line });
              }
            }
          });

          childProcess.on("close", (code: number | null) => {
            this.context.myDispatch({ type: "exit", code });
            resolve();
          });

          childProcess.on("error", (error: Error) => {
            reject(error);
          });
        }),
        300000,
      );
    } catch (error) {
      if (this.state.state == "processing" && this.state.childProcess) {
        this.state.childProcess.kill();
      }

      const errorMessage =
        error instanceof Error
          ? error.message + "\n" + error.stack
          : String(error);

      this.context.myDispatch({
        type: "stderr",
        text: errorMessage,
      });
      this.context.myDispatch({ type: "exit", code: 1 });
    } finally {
      this.stopTickInterval();
    }
  }

  isDone(): boolean {
    return this.state.state === "done" || this.state.state === "error";
  }

  isPendingUserAction(): boolean {
    return this.state.state === "pending-user-action";
  }

  /** It is the expectation that this is happening as part of a dispatch, so it should not trigger
   * new dispatches...
   */
  abort(): void {
    this.stopTickInterval();
    this.terminate();

    if (this.state.state == "pending-user-action") {
      this.state = {
        state: "done",
        exitCode: -1,
        output: [],
        result: {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "error",
            error: `The user aborted this command.`,
          },
        },
      };
    }
  }

  private trimOutputByTokens(output: OutputLine[]): OutputLine[] {
    const maxCharacters = MAX_OUTPUT_TOKENS_FOR_AGENT * CHARACTERS_PER_TOKEN;
    let totalCharacters = 0;
    const result: OutputLine[] = [];

    // Work backwards through the output to find the tail that fits within token limit
    for (let i = output.length - 1; i >= 0; i--) {
      const line = output[i];
      const lineLength = line.text.length + 1; // +1 for newline

      if (totalCharacters + lineLength > maxCharacters && result.length > 0) {
        // We've hit the limit, stop here
        break;
      }

      result.unshift(line);
      totalCharacters += lineLength;
    }

    return result;
  }

  formatOutputPreview(output: OutputLine[]): string {
    let formattedOutput = "";
    let currentStream: "stdout" | "stderr" | null = null;
    const lastTenLines = output.slice(-10);

    for (const line of lastTenLines) {
      // Add stream marker only when switching or at the beginning
      if (currentStream !== line.stream) {
        formattedOutput += line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
        currentStream = line.stream;
      }
      // Truncate line to WIDTH - 5 characters for display only
      const displayWidth = this.context.getDisplayWidth() - 5;
      const displayText =
        line.text.length > displayWidth
          ? line.text.substring(0, displayWidth) + "..."
          : line.text;
      formattedOutput += displayText + "\n";
    }

    return formattedOutput;
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
            error: `Error: ${state.error}`,
          },
        };

      case "pending-user-action":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `Waiting for user approval to run this command.`,
              },
            ],
          },
        };

      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [{ type: "text", text: "Command still running" }],
          },
        };

      default:
        assertUnreachable(state);
    }
  }

  renderSummary() {
    switch (this.state.state) {
      case "pending-user-action":
        return d`⚡⏳ May I run command ${withInlineCode(d`\`${this.request.input.command}\``)}?

┌───────────────────────────┐
│ ${withBindings(
          withExtmark(d`[ NO ]`, {
            hl_group: ["ErrorMsg", "@markup.strong.markdown"],
          }),
          {
            "<CR>": () =>
              this.context.myDispatch({
                type: "user-approval",
                approved: false,
              }),
          },
        )} ${withBindings(
          withExtmark(d`[ YES ]`, {
            hl_group: ["String", "@markup.strong.markdown"],
          }),
          {
            "<CR>": () =>
              this.context.myDispatch({
                type: "user-approval",
                approved: true,
              }),
          },
        )} ${withBindings(
          withExtmark(d`[ ALWAYS ]`, {
            hl_group: ["WarningMsg", "@markup.strong.markdown"],
          }),
          {
            "<CR>": () =>
              this.context.myDispatch({
                type: "user-approval",
                approved: true,
                remember: true,
              }),
          },
        )} │
└───────────────────────────┘`;
      case "processing": {
        const runningTime = Math.floor(
          (Date.now() - this.state.startTime) / 1000,
        );
        const content = d`⚡⚙️ (${String(runningTime)}s / 300s) ${withInlineCode(d`\`${this.request.input.command}\``)}`;
        return withBindings(content, {
          t: () => this.context.myDispatch({ type: "terminate" }),
        });
      }
      case "done": {
        if (this.state.exitCode === 0) {
          return d`⚡✅ ${withInlineCode(d`\`${this.request.input.command}\``)}`;
        } else {
          return d`⚡❌ ${withInlineCode(d`\`${this.request.input.command}\``)} - Exit code: ${this.state.exitCode !== undefined ? this.state.exitCode.toString() : "undefined"} `;
        }
      }
      case "error":
        return d`⚡❌ ${withInlineCode(d`\`${this.request.input.command}\``)} - ${this.state.error}`;
      default:
        assertUnreachable(this.state);
    }
  }
  renderPreview() {
    switch (this.state.state) {
      case "pending-user-action":
        return d``;
      case "processing": {
        const formattedOutput = this.formatOutputPreview(this.state.output);
        return formattedOutput
          ? withCode(
              d`\`\`\`
${formattedOutput}
\`\`\``,
            )
          : d``;
      }
      case "done": {
        const formattedOutput = this.formatOutputPreview(this.state.output);
        if (this.state.exitCode === 0) {
          return withCode(
            d`\`\`\`
${formattedOutput}
\`\`\``,
          );
        } else {
          return d`❌ Exit code: ${this.state.exitCode !== undefined ? this.state.exitCode.toString() : "undefined"}
${withCode(d`\`\`\`
${formattedOutput}
\`\`\``)}`;
        }
      }
      case "error":
        return d`❌ ${this.state.error}`;
      default:
        assertUnreachable(this.state);
    }
  }
}
