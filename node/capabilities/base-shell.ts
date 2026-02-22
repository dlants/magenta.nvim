import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { Shell, ShellResult, OutputLine } from "./shell.ts";
import type { NvimCwd } from "../utils/files.ts";
import type { ThreadId } from "../chat/types.ts";
import { MAGENTA_TEMP_DIR } from "../utils/files.ts";
import { withTimeout } from "../utils/async.ts";

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_REGEX = /\x1B\[[0-9;]*[a-zA-Z]/g;

function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "");
}

export class BaseShell implements Shell {
  private runningProcess: ReturnType<typeof spawn> | undefined;

  constructor(
    private context: {
      cwd: NvimCwd;
      threadId: ThreadId;
    },
  ) {}

  terminate(): void {
    const childProcess = this.runningProcess;
    if (!childProcess) return;

    const pid = childProcess.pid;
    if (pid) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        childProcess.kill("SIGTERM");
      }
    } else {
      childProcess.kill("SIGTERM");
    }

    // Escalate to SIGKILL after 1 second
    setTimeout(() => {
      if (this.runningProcess === childProcess) {
        if (pid) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            childProcess.kill("SIGKILL");
          }
        } else {
          childProcess.kill("SIGKILL");
        }
      }
    }, 1000);
  }

  async execute(
    command: string,
    opts: {
      toolRequestId: string;
      onOutput?: (line: OutputLine) => void;
      onStart?: () => void;
    },
  ): Promise<ShellResult> {
    const logDir = path.join(
      MAGENTA_TEMP_DIR,
      "threads",
      this.context.threadId,
      "tools",
      opts.toolRequestId,
    );
    fs.mkdirSync(logDir, { recursive: true });
    const logFilePath = path.join(logDir, "bashCommand.log");
    const logStream = fs.createWriteStream(logFilePath, { flags: "w" });
    logStream.write(`$ ${command}\n`);
    let logCurrentStream: "stdout" | "stderr" | undefined;

    const writeToLog = (stream: "stdout" | "stderr", text: string) => {
      if (logCurrentStream !== stream) {
        logStream.write(`${stream}:\n`);
        logCurrentStream = stream;
      }
      logStream.write(`${text}\n`);
    };

    const output: OutputLine[] = [];
    const startTime = Date.now();

    try {
      const result = await withTimeout(
        new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve, reject) => {
          const childProcess = spawn("bash", ["-c", command], {
            stdio: ["ignore", "pipe", "pipe"],
            cwd: this.context.cwd,
            env: process.env,
            detached: true,
          });
          this.runningProcess = childProcess;
          opts.onStart?.();

          childProcess.stdout?.on("data", (data: Buffer) => {
            const text = stripAnsiCodes(data.toString());
            const lines = text.split("\n");
            for (const line of lines) {
              if (line.trim()) {
                const outputLine: OutputLine = { stream: "stdout", text: line };
                output.push(outputLine);
                writeToLog("stdout", line);
                opts.onOutput?.(outputLine);
              }
            }
          });

          childProcess.stderr?.on("data", (data: Buffer) => {
            const text = stripAnsiCodes(data.toString());
            const lines = text.split("\n");
            for (const line of lines) {
              if (line.trim()) {
                const outputLine: OutputLine = { stream: "stderr", text: line };
                output.push(outputLine);
                writeToLog("stderr", line);
                opts.onOutput?.(outputLine);
              }
            }
          });

          childProcess.on(
            "close",
            (code: number | null, signal: NodeJS.Signals | null) => {
              resolve({ code, signal });
            },
          );

          childProcess.on("error", (error: Error) => {
            reject(error);
          });
        }),
        300000,
      );

      const durationMs = Date.now() - startTime;

      if (result.signal) {
        logStream.write(`terminated by signal ${result.signal}\n`);
      } else {
        logStream.write(`exit code ${result.code}\n`);
      }
      logStream.end();
      this.runningProcess = undefined;

      return {
        exitCode: result.code ?? -1,
        signal: result.signal ?? undefined,
        output,
        logFilePath,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;

      if (this.runningProcess) {
        this.runningProcess.kill();
        this.runningProcess = undefined;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);

      output.push({ stream: "stderr", text: errorMessage });
      writeToLog("stderr", errorMessage);
      logStream.write(`exit code 1\n`);
      logStream.end();

      return {
        exitCode: 1,
        signal: undefined,
        output,
        logFilePath,
        durationMs,
      };
    }
  }
}
