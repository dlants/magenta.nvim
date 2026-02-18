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
  type VDOMNode,
} from "../tea/view.ts";
import type { CompletedToolInfo } from "./types.ts";
import type { Nvim } from "../nvim/nvim-node";
import { spawn, spawnSync } from "child_process";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { MagentaOptions } from "../options.ts";
import { withTimeout } from "../utils/async.ts";
import type { StaticTool, ToolName, GenericToolRequest } from "./types.ts";
import {
  type NvimCwd,
  type UnresolvedFilePath,
  type HomeDir,
  MAGENTA_TEMP_DIR,
} from "../utils/files.ts";
import {
  isCommandAllowedByConfig,
  type PermissionCheckResult,
} from "./bash-parser/permissions.ts";
import type { ThreadId } from "../chat/types.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import * as fs from "fs";
import * as path from "path";

const MAX_OUTPUT_TOKENS_FOR_AGENT = 2000;
const MAX_CHARS_PER_LINE = 800; // When abbreviating, truncate long lines
const CHARACTERS_PER_TOKEN = 4;

// Regex to match ANSI escape codes (colors, cursor movement, etc.)
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_REGEX = /\x1B\[[0-9;]*[a-zA-Z]/g;

function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "");
}

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
For example, you can run \`ls\`, \`echo 'Hello, World!'\`, or \`git status\`.
The command will time out after 1 min.
You should not run commands that require user input, such as \`git commit\` without \`-m\` or \`ssh\`.
You should not run commands that do not halt, such as \`docker compose up\` without \`-d\`, \`tail -f\` or \`watch\`.

Long output will be abbreviated (first 10 + last 20 lines). Full output is saved to a log file that can be read with get_file. You do not need to use head/tail/grep to limit output - just run the command directly.
You will get the stdout and stderr of the command, as well as the exit code, so you do not need to do stream redirects like "2>&1".
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

export type ToolRequest = GenericToolRequest<"bash_command", Input>;

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
      durationMs: number;
      result: ProviderToolResult;
    }
  | {
      state: "error";
      error: string;
      durationMs?: number;
    };

export type Msg =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null }
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
  homeDir,
}: {
  command: string;
  options: MagentaOptions;
  rememberedCommands: Set<string>;
  cwd: NvimCwd;
  homeDir: HomeDir;
}): PermissionCheckResult {
  // First check remembered commands
  if (rememberedCommands.has(command)) {
    return { allowed: true };
  }

  return isCommandAllowedByConfig(command, options.commandConfig, {
    cwd,
    homeDir,
    skillsPaths: options.skillsPaths,
    filePermissions: options.filePermissions,
  });
}

export class BashCommandTool implements StaticTool {
  state: State;
  toolName = "bash_command" as const;
  aborted: boolean = false;
  private tickInterval: ReturnType<typeof setInterval> | undefined;
  private logStream: fs.WriteStream | undefined;
  private logFilePath: string | undefined;
  private logCurrentStream: "stdout" | "stderr" | undefined;

  constructor(
    public request: ToolRequest,
    public context: {
      nvim: Nvim;
      cwd: NvimCwd;
      homeDir: HomeDir;
      options: MagentaOptions;
      myDispatch: Dispatch<Msg>;
      rememberedCommands: Set<string>;
      getDisplayWidth(): number;
      threadId: ThreadId;
    },
  ) {
    // Check permissions synchronously
    const permissionResult = checkCommandPermissions({
      command: request.input.command,
      options: this.context.options,
      rememberedCommands: this.context.rememberedCommands,
      cwd: this.context.cwd,
      homeDir: this.context.homeDir,
    });

    if (permissionResult.allowed) {
      this.state = {
        state: "processing",
        output: [],
        startTime: Date.now(),
        approved: true,
        childProcess: null,
      };
      this.initLogFile();
      // wrap in setTimeout to force a new eventloop frame, to avoid dispatch-in-dispatch
      setTimeout(() => {
        if (this.aborted) return;
        this.executeCommand().catch((err: Error) => {
          if (this.aborted) return;
          this.context.myDispatch({
            type: "error",
            error: err.message + "\n" + err.stack,
          });
        });
      });
    } else {
      this.state = {
        state: "pending-user-action",
      };
    }
  }

  private initLogFile(): void {
    const logDir = path.join(
      MAGENTA_TEMP_DIR,
      "threads",
      this.context.threadId,
      "tools",
      this.request.id,
    );
    fs.mkdirSync(logDir, { recursive: true });
    this.logFilePath = path.join(logDir, "bashCommand.log");
    this.logStream = fs.createWriteStream(this.logFilePath, { flags: "w" });
    this.logStream.write(`$ ${this.request.input.command}\n`);
  }

  private closeLogStream(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = undefined;
    }
  }

  private writeToLog(stream: "stdout" | "stderr", text: string): void {
    if (!this.logStream) return;
    if (this.logCurrentStream !== stream) {
      this.logStream.write(`${stream}:\n`);
      this.logCurrentStream = stream;
    }
    this.logStream.write(`${text}\n`);
  }

  private abbreviateLine(text: string): string {
    if (text.length <= MAX_CHARS_PER_LINE) {
      return text;
    }
    // Show first half and last portion with ellipsis in middle
    const halfLength = Math.floor(MAX_CHARS_PER_LINE / 2) - 3; // -3 for "..."
    return (
      text.substring(0, halfLength) +
      "..." +
      text.substring(text.length - halfLength)
    );
  }

  private formatOutputForToolResult(
    output: OutputLine[],
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    durationMs: number,
  ): string {
    const totalLines = output.length;
    const totalBudgetChars = MAX_OUTPUT_TOKENS_FOR_AGENT * CHARACTERS_PER_TOKEN;

    // First, calculate total raw output size
    let totalRawChars = 0;
    for (const line of output) {
      totalRawChars += line.text.length + 1; // +1 for newline
    }

    // If under budget, return as-is without any abbreviation
    if (totalRawChars <= totalBudgetChars) {
      let formattedOutput = "";
      let currentStream: "stdout" | "stderr" | null = null;

      for (const line of output) {
        if (currentStream !== line.stream) {
          formattedOutput +=
            line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
          currentStream = line.stream;
        }
        formattedOutput += line.text + "\n";
      }

      if (signal) {
        formattedOutput += `terminated by signal ${signal} (${durationMs}ms)\n`;
      } else {
        formattedOutput += `exit code ${exitCode} (${durationMs}ms)\n`;
      }

      if (this.logFilePath) {
        formattedOutput += `\nFull output (${totalLines} lines): ${this.logFilePath}`;
      }

      return formattedOutput;
    }

    // Over budget - need to abbreviate lines and omit from the middle
    const headBudgetChars = Math.floor(totalBudgetChars * 0.3);
    const tailBudgetChars = Math.floor(totalBudgetChars * 0.7);

    // Collect lines from the beginning (30% budget)
    const headLines: { line: OutputLine; text: string }[] = [];
    let headChars = 0;
    for (let i = 0; i < output.length; i++) {
      const text = this.abbreviateLine(output[i].text);
      const lineLength = text.length + 1; // +1 for newline
      if (headChars + lineLength > headBudgetChars && headLines.length > 0) {
        break;
      }
      headLines.push({ line: output[i], text });
      headChars += lineLength;
    }

    // Collect lines from the end (70% budget), starting after head lines
    const tailLines: { line: OutputLine; text: string }[] = [];
    let tailChars = 0;
    const tailStartIndex = headLines.length;
    for (let i = output.length - 1; i >= tailStartIndex; i--) {
      const text = this.abbreviateLine(output[i].text);
      const lineLength = text.length + 1;
      if (tailChars + lineLength > tailBudgetChars && tailLines.length > 0) {
        break;
      }
      tailLines.unshift({ line: output[i], text });
      tailChars += lineLength;
    }

    // Calculate omitted lines
    const firstTailIndex =
      tailLines.length > 0 ? output.indexOf(tailLines[0].line) : output.length;
    const omittedCount = firstTailIndex - headLines.length;

    // Build formatted output
    let formattedOutput = "";
    let currentStream: "stdout" | "stderr" | null = null;

    // Add head lines
    for (const { line, text } of headLines) {
      if (currentStream !== line.stream) {
        formattedOutput += line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
        currentStream = line.stream;
      }
      formattedOutput += text + "\n";
    }

    // Add omission marker if needed
    if (omittedCount > 0) {
      formattedOutput += `\n... (${omittedCount} lines omitted) ...\n\n`;
    }

    // Add tail lines
    for (const { line, text } of tailLines) {
      if (currentStream !== line.stream) {
        formattedOutput += line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
        currentStream = line.stream;
      }
      formattedOutput += text + "\n";
    }

    if (signal) {
      formattedOutput += `terminated by signal ${signal} (${durationMs}ms)\n`;
    } else {
      formattedOutput += `exit code ${exitCode} (${durationMs}ms)\n`;
    }

    // Always include log file reference when we've abbreviated
    if (this.logFilePath) {
      formattedOutput += `\nFull output (${totalLines} lines): ${this.logFilePath}`;
    }

    return formattedOutput;
  }

  update(msg: Msg) {
    if (this.state.state === "done" || this.state.state === "error") {
      return;
    }
    if (this.aborted) {
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
          this.initLogFile();

          // wrap in setTimeout to force a new eventloop frame to avoid dispatch-in-dispatch
          setTimeout(() => {
            if (this.aborted) return;
            this.executeCommand().catch((err: Error) => {
              if (this.aborted) return;
              this.context.myDispatch({
                type: "error",
                error: err.message + "\n" + err.stack,
              });
            });
          });
          return;
        } else {
          const errorMessage = this.aborted
            ? `Request was aborted by user.`
            : `The user did not allow running this command.`;
          this.state = {
            state: "done",
            exitCode: 1,
            durationMs: 0,
            output: [],
            result: {
              type: "tool_result",
              id: this.request.id,
              result: {
                status: "error",
                error: errorMessage,
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
          this.writeToLog("stdout", msg.text);
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
          this.writeToLog("stderr", msg.text);
        }
        return;
      }

      case "exit": {
        if (this.state.state !== "processing") {
          return;
        }

        const durationMs = Date.now() - this.state.startTime;

        if (msg.signal) {
          this.logStream?.write(`terminated by signal ${msg.signal}\n`);
        } else {
          this.logStream?.write(`exit code ${msg.code}\n`);
        }
        this.closeLogStream();

        const formattedOutput = this.formatOutputForToolResult(
          this.state.output,
          msg.code,
          msg.signal,
          durationMs,
        );

        // If aborted, include that context in the result
        const resultText = this.aborted
          ? `Request was aborted by user.\n${formattedOutput}`
          : formattedOutput;

        this.state = {
          state: "done",
          exitCode: msg.code != undefined ? msg.code : -1,
          durationMs,
          output: this.state.output,
          result: {
            type: "tool_result",
            id: this.request.id,
            result: {
              status: "ok",
              value: [{ type: "text", text: resultText }],
            },
          },
        };
        return;
      }

      case "error": {
        const durationMs =
          this.state.state === "processing"
            ? Date.now() - this.state.startTime
            : undefined;
        this.closeLogStream();
        this.state =
          durationMs !== undefined
            ? {
                state: "error",
                error: msg.error,
                durationMs,
              }
            : {
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
      const childProcess = this.state.childProcess;
      const pid = childProcess.pid;

      // Kill the entire process group (negative PID) since we spawn with detached: true
      // This ensures all child processes are also terminated
      if (pid) {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          // Process group may already be dead
          childProcess.kill("SIGTERM");
        }
      } else {
        childProcess.kill("SIGTERM");
      }

      this.state.output.push({
        stream: "stderr",
        text: "Process terminated by user with SIGTERM",
      });
      this.writeToLog("stderr", "Process terminated by user with SIGTERM");

      // Escalate to SIGKILL after 1 second if process hasn't exited yet
      setTimeout(() => {
        // If still in processing state, the process hasn't exited from SIGTERM
        if (this.state.state === "processing") {
          if (pid) {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              // Process group may already be dead
              childProcess.kill("SIGKILL");
            }
          } else {
            childProcess.kill("SIGKILL");
          }
          this.state.output.push({
            stream: "stderr",
            text: "Process killed with SIGKILL after 1s timeout",
          });
          this.writeToLog(
            "stderr",
            "Process killed with SIGKILL after 1s timeout",
          );
        }
      }, 1000);
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
            stdio: ["ignore", "pipe", "pipe"],
            cwd: this.context.cwd,
            env: process.env,
            detached: true,
          });

          if (this.state.state === "processing") {
            this.state.childProcess = childProcess;
          }

          childProcess.stdout?.on("data", (data: Buffer) => {
            const text = stripAnsiCodes(data.toString());
            const lines = text.split("\n");
            for (const line of lines) {
              if (line.trim()) {
                this.context.myDispatch({ type: "stdout", text: line });
              }
            }
          });

          childProcess.stderr?.on("data", (data: Buffer) => {
            const text = stripAnsiCodes(data.toString());
            const lines = text.split("\n");
            for (const line of lines) {
              if (line.trim()) {
                this.context.myDispatch({ type: "stderr", text: line });
              }
            }
          });

          childProcess.on(
            "close",
            (code: number | null, signal: NodeJS.Signals | null) => {
              this.context.myDispatch({ type: "exit", code, signal });
              resolve();
            },
          );

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
      this.context.myDispatch({ type: "exit", code: 1, signal: null });
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

  abort(): ProviderToolResult {
    if (this.state.state === "done" || this.state.state === "error") {
      return this.getToolResult();
    }

    this.aborted = true;
    this.stopTickInterval();

    if (this.state.state === "processing" && this.state.childProcess) {
      // Kill the process but don't wait for exit handler
      this.terminate();
    }

    this.closeLogStream();

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
      exitCode: -1,
      durationMs: 0,
      output: [],
      result,
    };

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

      case "error": {
        const durationStr =
          state.durationMs !== undefined ? ` (${state.durationMs}ms)` : "";
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "error",
            error: `Error: ${state.error}${durationStr}`,
          },
        };
      }

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
${withBindings(
  withExtmark(d`> NO`, {
    hl_group: ["ErrorMsg", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () =>
      this.context.myDispatch({
        type: "user-approval",
        approved: false,
      }),
  },
)}
${withBindings(
  withExtmark(d`> YES`, {
    hl_group: ["String", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () =>
      this.context.myDispatch({
        type: "user-approval",
        approved: true,
      }),
  },
)}
${withBindings(
  withExtmark(d`> ALWAYS`, {
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
)}`;
      case "processing": {
        const runningTime = Math.floor(
          (Date.now() - this.state.startTime) / 1000,
        );
        const content = d`⚡⚙️ (${String(runningTime)}s / 300s) ${withInlineCode(d`\`${this.request.input.command}\``)}`;
        return withBindings(content, {
          t: () => this.context.myDispatch({ type: "terminate" }),
        });
      }
      case "done":
        return renderCompletedSummary({
          request: this.request as CompletedToolInfo["request"],
          result: this.state.result,
        });
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
        return renderCompletedPreview(
          {
            request: this.request as CompletedToolInfo["request"],
            result: this.state.result,
          },
          this.context,
        );
      }
      case "error":
        return d`❌ ${this.state.error}`;
      default:
        assertUnreachable(this.state);
    }
  }

  renderDetail(): VDOMNode {
    const renderContext: RenderContext = {
      getDisplayWidth: this.context.getDisplayWidth.bind(this.context),
      nvim: this.context.nvim,
      cwd: this.context.cwd,
      homeDir: this.context.homeDir,
      options: this.context.options,
    };

    switch (this.state.state) {
      case "pending-user-action":
        return d`command: ${withInlineCode(d`\`${this.request.input.command}\``)}`;
      case "processing": {
        return renderOutputDetail(
          this.state.output,
          this.logFilePath,
          renderContext,
        );
      }
      case "done": {
        return renderCompletedDetail(
          {
            request: this.request as CompletedToolInfo["request"],
            result: this.state.result,
          },
          renderContext,
        );
      }
      case "error":
        return d`command: ${withInlineCode(d`\`${this.request.input.command}\``)}\n❌ ${this.state.error}`;
      default:
        assertUnreachable(this.state);
    }
  }
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;

  if (result.status === "error") {
    return d`⚡❌ ${withInlineCode(d`\`${input.command}\``)} - ${result.error}`;
  }

  // Try to extract exit code and signal from result text
  let exitCode: number | undefined;
  let signal: string | undefined;
  if (result.value.length > 0) {
    const firstValue = result.value[0];
    if (firstValue.type === "text") {
      const exitCodeMatch = firstValue.text.match(/exit code (\d+)/);
      if (exitCodeMatch) {
        exitCode = parseInt(exitCodeMatch[1], 10);
      }
      const signalMatch = firstValue.text.match(/terminated by signal (\w+)/);
      if (signalMatch) {
        signal = signalMatch[1];
      }
    }
  }

  // Show failure if terminated by signal
  if (signal) {
    return d`⚡❌ ${withInlineCode(d`\`${input.command}\``)} - Terminated by ${signal}`;
  }

  // Show failure if non-zero exit code
  if (exitCode !== undefined && exitCode !== 0) {
    return d`⚡❌ ${withInlineCode(d`\`${input.command}\``)} - Exit code: ${exitCode.toString()}`;
  }

  return d`⚡✅ ${withInlineCode(d`\`${input.command}\``)}`;
}

export type RenderContext = {
  getDisplayWidth: () => number;
  nvim: Nvim;
  cwd: NvimCwd;
  homeDir: HomeDir;
  options: MagentaOptions;
};

export function renderCompletedPreview(
  info: CompletedToolInfo,
  context: RenderContext,
): VDOMNode {
  const result = info.result.result;

  if (result.status !== "ok" || result.value.length === 0) {
    return d``;
  }

  const firstValue = result.value[0];
  if (firstValue.type !== "text") {
    return d``;
  }

  const text = firstValue.text;
  // Remove the "Full output" line since we render it separately with bindings
  const textWithoutLogLine = text.replace(
    /\n?Full output \(\d+ lines\): .+$/m,
    "",
  );
  const lines = textWithoutLogLine.split("\n");
  const maxLines = 10;
  const maxLength = context.getDisplayWidth() - 5;

  let previewLines = lines.length > maxLines ? lines.slice(-maxLines) : lines;
  previewLines = previewLines.map((line) =>
    line.length > maxLength ? line.substring(0, maxLength) + "..." : line,
  );

  const previewText = previewLines.join("\n");

  // Extract exit code to check for errors
  const exitCodeMatch = text.match(/exit code (\d+)/);
  const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : undefined;

  // Extract log file path and render with binding
  const logFileView = renderLogFileLink(text, context);

  if (exitCode !== undefined && exitCode !== 0) {
    return d`❌ Exit code: ${exitCode.toString()}
${withCode(d`\`\`\`
${previewText}
\`\`\``)}${logFileView}`;
  }

  return d`${withCode(d`\`\`\`
${previewText}
\`\`\``)}${logFileView}`;
}

function renderOutputDetail(
  output: OutputLine[],
  logFilePath: string | undefined,
  context: RenderContext,
): VDOMNode {
  let formattedOutput = "";
  let currentStream: "stdout" | "stderr" | null = null;

  for (const line of output) {
    if (currentStream !== line.stream) {
      formattedOutput += line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
      currentStream = line.stream;
    }
    formattedOutput += line.text + "\n";
  }

  const logFileView = logFilePath
    ? renderLogFileLinkDirect(logFilePath, output.length, context)
    : d``;

  return d`${withCode(d`\`\`\`
${formattedOutput}
\`\`\``)}${logFileView}`;
}

function renderLogFileLinkDirect(
  logFilePath: string,
  lineCount: number,
  context: RenderContext,
): VDOMNode {
  return withBindings(
    d`\nFull output (${lineCount.toString()} lines): ${withInlineCode(d`\`${logFilePath}\``)}`,
    {
      "<CR>": () => {
        openFileInNonMagentaWindow(
          logFilePath as UnresolvedFilePath,
          context,
        ).catch((e: Error) => context.nvim.logger.error(e.message));
      },
    },
  );
}

function renderLogFileLink(text: string, context: RenderContext): VDOMNode {
  // Parse "Full output (N lines): /path/to/file" from the text
  const match = text.match(/Full output \((\d+) lines\): (.+)$/m);
  if (!match) {
    return d``;
  }

  const lineCount = match[1];
  const filePath = match[2];

  return withBindings(
    d`\nFull output (${lineCount} lines): ${withInlineCode(d`\`${filePath}\``)}`,
    {
      "<CR>": () => {
        openFileInNonMagentaWindow(
          filePath as UnresolvedFilePath,
          context,
        ).catch((e: Error) => context.nvim.logger.error(e.message));
      },
    },
  );
}

export function renderCompletedDetail(
  info: CompletedToolInfo,
  context: RenderContext,
): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;

  if (result.status !== "ok" || result.value.length === 0) {
    return d`command: ${withInlineCode(d`\`${input.command}\``)}\n${result.status === "error" ? d`❌ ${result.error}` : d``}`;
  }

  const firstValue = result.value[0];
  if (firstValue.type !== "text") {
    return d`command: ${withInlineCode(d`\`${input.command}\``)}`;
  }

  // Remove the "Full output" line from the code block since we render it separately with bindings
  const textWithoutLogLine = firstValue.text.replace(
    /\n?Full output \(\d+ lines\): .+$/m,
    "",
  );
  const logFileView = renderLogFileLink(firstValue.text, context);

  return d`command: ${withInlineCode(d`\`${input.command}\``)}
${withCode(d`\`\`\`
${textWithoutLogLine}
\`\`\``)}${logFileView}`;
}
