import * as fs from "fs";
import * as path from "path";
import type { OutputLine } from "./shell.ts";
import { MAGENTA_TEMP_DIR } from "../utils/files.ts";
import type { spawn } from "child_process";

// eslint-disable-next-line no-control-regex
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

export function createLogWriter(
  threadId: string,
  toolRequestId: string,
  command: string,
): LogWriter {
  const logDir = path.join(
    MAGENTA_TEMP_DIR,
    "threads",
    threadId,
    "tools",
    toolRequestId,
  );
  fs.mkdirSync(logDir, { recursive: true });
  const logFilePath = path.join(logDir, "bashCommand.log");
  const logStream = fs.createWriteStream(logFilePath, { flags: "w" });
  logStream.write(`$ ${command}\n`);
  let currentStream: "stdout" | "stderr" | undefined;

  return {
    write(stream: "stdout" | "stderr", text: string) {
      if (currentStream !== stream) {
        logStream.write(`${stream}:\n`);
        currentStream = stream;
      }
      logStream.write(`${text}\n`);
    },
    writeRaw(text: string) {
      logStream.write(text);
    },
    end() {
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

export function terminateProcess(
  childProcess: ReturnType<typeof spawn>,
): void {
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