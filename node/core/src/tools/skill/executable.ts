import { type ChildProcess, spawn } from "node:child_process";
import type { OutputLine } from "../../capabilities/shell.ts";

export type SkillResult =
  | { status: "ok"; output: string }
  | { status: "error"; output: string; error: string };

export function executeSkill(
  command: string[],
  input: Record<string, unknown>,
  opts?: {
    signal?: AbortSignal;
    onOutput?: (line: OutputLine) => void;
  },
): Promise<SkillResult> {
  return new Promise((resolve) => {
    const args = [...command.slice(1), JSON.stringify(input)];
    let proc: ChildProcess;
    try {
      proc = spawn(command[0], args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      resolve({
        status: "error",
        output: "",
        error: `Failed to spawn skill process: ${(err as Error).message}`,
      });
      return;
    }

    const output: OutputLine[] = [];

    proc.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split("\n")) {
        if (line.length > 0 || text.endsWith("\n")) {
          const outputLine: OutputLine = { stream: "stdout", text: line };
          output.push(outputLine);
          opts?.onOutput?.(outputLine);
        }
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split("\n")) {
        if (line.length > 0 || text.endsWith("\n")) {
          const outputLine: OutputLine = { stream: "stderr", text: line };
          output.push(outputLine);
          opts?.onOutput?.(outputLine);
        }
      }
    });

    if (opts?.signal) {
      opts.signal.addEventListener(
        "abort",
        () => {
          const pid = proc.pid;
          if (pid) {
            try {
              process.kill(-pid, "SIGTERM");
            } catch {
              proc.kill("SIGTERM");
            }
          } else {
            proc.kill("SIGTERM");
          }
          setTimeout(() => {
            if (pid) {
              try {
                process.kill(-pid, "SIGKILL");
              } catch {
                proc.kill("SIGKILL");
              }
            } else {
              proc.kill("SIGKILL");
            }
          }, 5000);
        },
        { once: true },
      );
    }

    proc.on("error", (err: Error) => {
      resolve({
        status: "error",
        output: formatOutput(output),
        error: `Failed to spawn skill process: ${err.message}`,
      });
    });

    proc.on("close", (code: number | null) => {
      const outputStr = formatOutput(output);
      if (code !== 0) {
        resolve({
          status: "error",
          output: outputStr,
          error: `Skill process exited with code ${code ?? "unknown"}`,
        });
        return;
      }
      resolve({
        status: "ok",
        output: outputStr,
      });
    });
  });
}

function formatOutput(output: OutputLine[]): string {
  let formatted = "";
  let currentStream: "stdout" | "stderr" | null = null;
  for (const line of output) {
    if (currentStream !== line.stream) {
      formatted += line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
      currentStream = line.stream;
    }
    formatted += `${line.text}\n`;
  }
  return formatted;
}
