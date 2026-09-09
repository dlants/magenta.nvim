import type { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { MAGENTA_TEMP_DIR } from "../utils/files.ts";
import type { OutputLine } from "./shell.ts";

const ANSI_ESCAPE_REGEX = /\x1B\[[0-9;]*[a-zA-Z]/g;

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "");
}

export type LogWriter = {
  write: (stream: "stdout" | "stderr", text: string) => void;
  writeRaw: (text: string) => void;
  end: () => void;
  filePath: string;
};

export function toolLogDir(threadId: string, toolRequestId: string): string {
  return path.join(
    MAGENTA_TEMP_DIR,
    "threads",
    threadId,
    "tools",
    toolRequestId,
  );
}

export function createLogWriter(
  threadId: string,
  toolRequestId: string,
  command: string,
): LogWriter {
  const logDir = toolLogDir(threadId, toolRequestId);
  fs.mkdirSync(logDir, { recursive: true });
  const logFilePath = path.join(logDir, "bashCommand.log");
  const logStream = fs.createWriteStream(logFilePath, { flags: "w" });
  // Avoid crashing the process on stream errors (e.g. write-after-end caused
  // by late data events from a killed detached process group).
  logStream.on("error", () => {});
  logStream.write(`$ ${command}\n`);
  let currentStream: "stdout" | "stderr" | undefined;
  let ended = false;

  return {
    write(stream: "stdout" | "stderr", text: string) {
      if (ended) return;
      if (currentStream !== stream) {
        logStream.write(`${stream}:\n`);
        currentStream = stream;
      }
      logStream.write(`${text}\n`);
    },
    writeRaw(text: string) {
      if (ended) return;
      logStream.write(text);
    },
    end() {
      if (ended) return;
      ended = true;
      logStream.end();
    },
    filePath: logFilePath,
  };
}

export function processStreamData(
  stream: "stdout" | "stderr",
  data: Buffer,
  output: OutputLine[],
  logWriter: LogWriter,
  onOutput?: (line: OutputLine) => void,
): void {
  const text = stripAnsiCodes(data.toString());
  const lines = text.split("\n");
  for (const line of lines) {
    if (line.trim()) {
      const outputLine: OutputLine = { stream, text: line };
      output.push(outputLine);
      logWriter.write(stream, line);
      onOutput?.(outputLine);
    }
  }
}

export function terminateProcess(childProcess: ReturnType<typeof spawn>): void {
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
}

export function escalateToSigkill(
  childProcess: ReturnType<typeof spawn>,
): void {
  const pid = childProcess.pid;
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
