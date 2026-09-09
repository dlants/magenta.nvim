import { spawn } from "node:child_process";
import type { ThreadId } from "@magenta/server";
import { withTimeout } from "../utils/async.ts";
import type { OutputLine, Shell, ShellResult } from "./shell.ts";
import {
  createLogWriter,
  escalateToSigkill,
  processStreamData,
  terminateProcess,
} from "./shell-utils.ts";

export class DockerShell implements Shell {
  private runningProcess: ReturnType<typeof spawn> | undefined;

  constructor(
    private context: {
      container: string;
      cwd: string;
      threadId: ThreadId;
    },
  ) {}

  terminate(): void {
    const childProcess = this.runningProcess;
    if (!childProcess) return;

    terminateProcess(childProcess);

    setTimeout(() => {
      if (this.runningProcess === childProcess) {
        escalateToSigkill(childProcess);
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
    const logWriter = createLogWriter(
      this.context.threadId,
      opts.toolRequestId,
      command,
    );

    const output: OutputLine[] = [];
    const startTime = Date.now();

    try {
      const result = await withTimeout(
        new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve, reject) => {
          const childProcess = spawn(
            "docker",
            [
              "exec",
              "-w",
              this.context.cwd,
              this.context.container,
              "bash",
              "-c",
              command,
            ],
            {
              stdio: ["ignore", "pipe", "pipe"],
              detached: true,
            },
          );
          this.runningProcess = childProcess;
          opts.onStart?.();

          childProcess.stdout?.on("data", (data: Buffer) => {
            processStreamData("stdout", data, output, logWriter, opts.onOutput);
          });

          childProcess.stderr?.on("data", (data: Buffer) => {
            processStreamData("stderr", data, output, logWriter, opts.onOutput);
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
        logWriter.writeRaw(`terminated by signal ${result.signal}\n`);
      } else {
        logWriter.writeRaw(`exit code ${result.code}\n`);
      }
      logWriter.end();
      this.runningProcess = undefined;

      return {
        exitCode: result.code ?? -1,
        signal: result.signal ?? undefined,
        output,
        logFilePath: logWriter.filePath,
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
      logWriter.write("stderr", errorMessage);
      logWriter.writeRaw(`exit code 1\n`);
      logWriter.end();

      return {
        exitCode: 1,
        signal: undefined,
        output,
        logFilePath: logWriter.filePath,
        durationMs,
      };
    }
  }
}
