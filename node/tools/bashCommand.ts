import type { Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";

import { spawnSync } from "child_process";
import type { MagentaOptions } from "../options.ts";
import type { ToolName, GenericToolRequest, ToolInvocation } from "./types.ts";

import type { Shell, OutputLine } from "../capabilities/shell.ts";

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

const MAX_OUTPUT_TOKENS_FOR_AGENT = 2000;
const MAX_CHARS_PER_LINE = 800;
const CHARACTERS_PER_TOKEN = 4;

function abbreviateLine(text: string): string {
  if (text.length <= MAX_CHARS_PER_LINE) {
    return text;
  }
  const halfLength = Math.floor(MAX_CHARS_PER_LINE / 2) - 3;
  return (
    text.substring(0, halfLength) +
    "..." +
    text.substring(text.length - halfLength)
  );
}

function formatOutputForToolResult(
  output: OutputLine[],
  exitCode: number,
  signal: NodeJS.Signals | undefined,
  durationMs: number,
  logFilePath: string | undefined,
): string {
  const totalLines = output.length;
  const totalBudgetChars = MAX_OUTPUT_TOKENS_FOR_AGENT * CHARACTERS_PER_TOKEN;

  let totalRawChars = 0;
  for (const line of output) {
    totalRawChars += line.text.length + 1;
  }

  if (totalRawChars <= totalBudgetChars) {
    let formattedOutput = "";
    let currentStream: "stdout" | "stderr" | null = null;

    for (const line of output) {
      if (currentStream !== line.stream) {
        formattedOutput += line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
        currentStream = line.stream;
      }
      formattedOutput += line.text + "\n";
    }

    if (signal) {
      formattedOutput += `terminated by signal ${signal} (${durationMs}ms)\n`;
    } else {
      formattedOutput += `exit code ${exitCode} (${durationMs}ms)\n`;
    }

    if (logFilePath) {
      formattedOutput += `\nFull output (${totalLines} lines): ${logFilePath}`;
    }

    return formattedOutput;
  }

  const headBudgetChars = Math.floor(totalBudgetChars * 0.3);
  const tailBudgetChars = Math.floor(totalBudgetChars * 0.7);

  const headLines: { line: OutputLine; text: string }[] = [];
  let headChars = 0;
  for (let i = 0; i < output.length; i++) {
    const text = abbreviateLine(output[i].text);
    const lineLength = text.length + 1;
    if (headChars + lineLength > headBudgetChars && headLines.length > 0) {
      break;
    }
    headLines.push({ line: output[i], text });
    headChars += lineLength;
  }

  const tailLines: { line: OutputLine; text: string }[] = [];
  let tailChars = 0;
  const tailStartIndex = headLines.length;
  for (let i = output.length - 1; i >= tailStartIndex; i--) {
    const text = abbreviateLine(output[i].text);
    const lineLength = text.length + 1;
    if (tailChars + lineLength > tailBudgetChars && tailLines.length > 0) {
      break;
    }
    tailLines.unshift({ line: output[i], text });
    tailChars += lineLength;
  }

  const firstTailIndex =
    tailLines.length > 0 ? output.indexOf(tailLines[0].line) : output.length;
  const omittedCount = firstTailIndex - headLines.length;

  let formattedOutput = "";
  let currentStream: "stdout" | "stderr" | null = null;

  for (const { line, text } of headLines) {
    if (currentStream !== line.stream) {
      formattedOutput += line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
      currentStream = line.stream;
    }
    formattedOutput += text + "\n";
  }

  if (omittedCount > 0) {
    formattedOutput += `\n... (${omittedCount} lines omitted) ...\n\n`;
  }

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

  if (logFilePath) {
    formattedOutput += `\nFull output (${totalLines} lines): ${logFilePath}`;
  }

  return formattedOutput;
}

// ===== New function-based ToolInvocation =====

export type BashProgress = {
  liveOutput: OutputLine[];
  startTime: number | undefined;
};

export function execute(
  request: ToolRequest,
  context: {
    shell: Shell;
    requestRender: () => void;
    options: MagentaOptions;
  },
): ToolInvocation & { progress: BashProgress } {
  const progress: BashProgress = {
    liveOutput: [],
    startTime: undefined,
  };

  let aborted = false;
  let tickInterval: ReturnType<typeof setInterval> | undefined;

  function stopTickInterval() {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = undefined;
    }
  }

  const promise = context.shell
    .execute(request.input.command, {
      toolRequestId: request.id,
      onOutput: (line) => {
        progress.liveOutput.push(line);
        context.requestRender();
      },
      onStart: () => {
        progress.startTime = Date.now();
        tickInterval = setInterval(() => {
          context.requestRender();
        }, 1000);
      },
    })
    .then((result): ProviderToolResult => {
      if (aborted) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Request was aborted by the user.",
          },
        };
      }
      stopTickInterval();

      const formattedOutput = formatOutputForToolResult(
        result.output,
        result.exitCode,
        result.signal,
        result.durationMs,
        result.logFilePath,
      );

      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: [{ type: "text", text: formattedOutput }],
        },
      };
    })
    .catch((error: Error): ProviderToolResult => {
      if (aborted) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Request was aborted by the user.",
          },
        };
      }
      stopTickInterval();

      const durationMs = progress.startTime
        ? Date.now() - progress.startTime
        : 0;
      const durationStr = durationMs > 0 ? ` (${durationMs}ms)` : "";

      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: `Error: ${error.message}${durationStr}`,
        },
      };
    });

  return {
    promise,
    abort: () => {
      aborted = true;
      stopTickInterval();
      context.shell.terminate();
    },
    progress,
  };
}
