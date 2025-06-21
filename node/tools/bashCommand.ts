import type { Result } from "../utils/result.ts";
import type { Dispatch } from "../tea/tea.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import { d, withBindings } from "../tea/view.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import type { Nvim } from "../nvim/nvim-node";
import { spawn } from "child_process";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { CommandAllowlist, MagentaOptions } from "../options.ts";
import { getcwd } from "../nvim/nvim.ts";
import { withTimeout } from "../utils/async.ts";
import type { StaticTool, ToolName } from "./types.ts";

export const spec: ProviderToolSpec = {
  name: "bash_command" as ToolName,
  description: `Run a command in a bash shell.
You will get the stdout and stderr of the command, as well as the exit code.
For example, you can run \`ls\`, \`echo 'Hello, World!'\`, or \`git status\`.
The command will time out after 1 min.
You should not run commands that require user input, such as \`git commit\` without \`-m\` or \`ssh\`.
You should not run commands that do not halt, such as \`docker compose up\` without \`-d\`, \`tail -f\` or \`watch\`.
`,

  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run in the terminal",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

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
  | { type: "terminate" };

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

export function isCommandAllowed(
  command: string,
  allowlist: CommandAllowlist,
  rememberedCommands?: Set<string>,
  logger?: Nvim["logger"],
): boolean {
  if (rememberedCommands && rememberedCommands.has(command)) {
    return true;
  }

  if (!command || !allowlist || !Array.isArray(allowlist)) {
    return false;
  }

  // Clean the command string to avoid any tricks
  const cleanCommand = command.trim();
  if (!cleanCommand) {
    return false;
  }

  for (const pattern of allowlist) {
    try {
      const regex = new RegExp(pattern);
      if (regex.test(cleanCommand)) {
        return true;
      }
    } catch (error) {
      logger?.error(`Invalid regex pattern: ${pattern}`, error);
      continue;
    }
  }

  return false;
}

export class BashCommandTool implements StaticTool {
  state: State;
  toolName = "bash_command" as const;

  constructor(
    public request: Extract<StaticToolRequest, { toolName: "bash_command" }>,
    public context: {
      nvim: Nvim;
      options: MagentaOptions;
      myDispatch: Dispatch<Msg>;
      rememberedCommands: Set<string>;
    },
  ) {
    const commandAllowlist = this.context.options.commandAllowlist;
    const isAllowed = isCommandAllowed(
      request.input.command,
      commandAllowlist,
      this.context.rememberedCommands,
      context.nvim.logger,
    );

    if (isAllowed) {
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

        // Trim line to 80 characters
        const trimmedText =
          msg.text.length > 80 ? msg.text.substring(0, 80) : msg.text;
        if (trimmedText.trim() !== "") {
          this.state.output.push({
            stream: "stdout",
            text: trimmedText,
          });
        }
        return;
      }

      case "stderr": {
        if (this.state.state !== "processing") {
          return;
        }

        // Trim line to 80 characters
        const trimmedText =
          msg.text.length > 80 ? msg.text.substring(0, 80) : msg.text;
        if (trimmedText.trim() !== "") {
          this.state.output.push({
            stream: "stderr",
            text: trimmedText,
          });
        }
        return;
      }

      case "exit": {
        if (this.state.state !== "processing") {
          return;
        }

        // Process the output array to format with stream markers
        // trim to last 1000 lines to avoid over-filling the context
        const outputTail = this.state.output.slice(-1000);
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

  async executeCommand(): Promise<void> {
    const { command } = this.request.input;

    let childProcess: ReturnType<typeof spawn> | null = null;

    // Get Neovim's current working directory
    const cwd = await getcwd(this.context.nvim);

    try {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          childProcess = spawn("bash", ["-c", command], {
            stdio: "pipe",
            cwd,
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
    }
  }

  isDone(): boolean {
    return this.state.state === "done" || this.state.state === "error";
  }

  /** It is the expectation that this is happening as part of a dispatch, so it should not trigger
   * new dispatches...
   */
  abort(): void {
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
      formattedOutput += line.text + "\n";
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

  view() {
    const { state } = this;

    if (state.state === "pending-user-action") {
      return d`⏳ May I run this command? \`${this.request.input.command}\`
${withBindings(d`**[ NO ]**`, {
  "<CR>": () =>
    this.context.myDispatch({ type: "user-approval", approved: false }),
})} ${withBindings(d`**[ YES ]**`, {
        "<CR>": () =>
          this.context.myDispatch({ type: "user-approval", approved: true }),
      })} ${withBindings(d`**[ ALWAYS ]**`, {
        "<CR>": () =>
          this.context.myDispatch({
            type: "user-approval",
            approved: true,
            remember: true,
          }),
      })}`;
    }

    if (state.state === "processing") {
      const runningTime = Math.floor((Date.now() - state.startTime) / 1000);
      const formattedOutput = this.formatOutputPreview(state.output);

      const content = d`⚡ (${String(runningTime)}s / 300s) \`${this.request.input.command}\`
\`\`\`
${formattedOutput}
\`\`\``;

      return withBindings(content, {
        t: () => this.context.myDispatch({ type: "terminate" }),
      });
    }

    if (state.state === "done") {
      // Use the same formatting as in getToolResult
      const formattedOutput = this.formatOutputPreview(state.output);

      return d`⚡ \`${this.request.input.command}\`
\`\`\`
${formattedOutput}
\`\`\`

Exit code: ${state.exitCode !== undefined ? state.exitCode.toString() : "undefined"}`;
    }

    if (state.state === "error") {
      return d`Error running command: ${state.error}`;
    }

    return d``;
  }

  displayInput(): string {
    return `bash_command: {
    command: ${this.request.input.command}
}`;
  }
}
