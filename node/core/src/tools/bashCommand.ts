import { spawnSync } from "node:child_process";
import type { OutputLine, Shell } from "../capabilities/shell.ts";
import {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderToolResult,
  type ProviderToolSpec,
} from "../providers/provider-types.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolName,
} from "../tool-types.ts";
import type { Result } from "../utils/result.ts";

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

Long output will be abbreviated (first 10 + last 20 lines). Full output is saved to a log file that can be read with get_files. You do not need to use head/tail/grep to limit output - just run the command directly.
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
export type StructuredResult = {
  toolName: "bash_command";
  exitCode: number;
  signal: string | undefined;
  logFilePath: string | undefined;
  logFileLineCount: number | undefined;
  logFileCharCount: number | undefined;
  outputText: string;
  wasAbbreviated: boolean;
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

function formatTokens(charCount: number): string {
  const tokens = Math.ceil(charCount / 4);
  return tokens >= 1000
    ? `~${Math.round(tokens / 1000).toString()}k tok`
    : `~${tokens.toString()} tok`;
}

const TRIM_REMINDER =
  "\nNote: a trailing `| head`/`| tail` was removed from your command. The bash_command tool already trims long output for you, so you don't need to pipe into head or tail.\n";

const RG_REPLACE_WARNING =
  "This command was NOT run. It looks like you passed a short `-r` flag to `rg`. " +
  "For ripgrep, `-r` is the short form of `--replace` and it consumes the rest of the flag bundle (and/or the next argument) as a replacement string — e.g. `-rn` means `--replace=n`, not `-r -n`. " +
  "`-r` does NOT mean recursive; rg recurses by default. " +
  "If you wanted line numbers use `-n`, for files-with-matches use `-l`. " +
  "If you genuinely want replacement, use the long `--replace` form instead.";

export function detectRgShortReplaceFlag(command: string): boolean {
  const segments = command.split(/&&|\|\||[;|\n]/);
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) {
      i++;
    }
    if (i >= tokens.length) continue;
    const program = tokens[i].split("/").pop();
    if (program !== "rg") continue;
    for (const tok of tokens.slice(i + 1)) {
      if (/^-[A-Za-z]*r[A-Za-z]*$/.test(tok)) {
        return true;
      }
    }
  }
  return false;
}

export function stripTrailingHeadTail(command: string): {
  command: string;
  wasTrimmed: boolean;
} {
  const trimmed = command.replace(/\s*\|\s*(?:head|tail)\b[^|]*$/, "");
  if (trimmed !== command) {
    return { command: trimmed, wasTrimmed: true };
  }
  return { command, wasTrimmed: false };
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
): { formattedOutput: string; wasAbbreviated: boolean } {
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
      formattedOutput += `${line.text}\n`;
    }

    if (signal) {
      formattedOutput += `terminated by signal ${signal} (${durationMs}ms)\n`;
    } else {
      formattedOutput += `exit code ${exitCode} (${durationMs}ms)\n`;
    }

    return { formattedOutput, wasAbbreviated: false };
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
    formattedOutput += `${text}\n`;
  }

  if (omittedCount > 0) {
    formattedOutput += `\n... (${omittedCount} lines omitted) ...\n\n`;
  }

  for (const { line, text } of tailLines) {
    if (currentStream !== line.stream) {
      formattedOutput += line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
      currentStream = line.stream;
    }
    formattedOutput += `${text}\n`;
  }

  if (signal) {
    formattedOutput += `terminated by signal ${signal} (${durationMs}ms)\n`;
  } else {
    formattedOutput += `exit code ${exitCode} (${durationMs}ms)\n`;
  }

  if (logFilePath) {
    formattedOutput += `\n⚠️  the result was abbreviated. To see full output (${formatTokens(totalRawChars)}): ${logFilePath}`;
  }

  return { formattedOutput, wasAbbreviated: true };
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
  },
): ToolInvocation & { progress: BashProgress } {
  const progress: BashProgress = {
    liveOutput: [],
    startTime: undefined,
  };

  const { command: sanitizedCommand, wasTrimmed } = stripTrailingHeadTail(
    request.input.command,
  );

  if (detectRgShortReplaceFlag(sanitizedCommand)) {
    return {
      promise: Promise.resolve({
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: RG_REPLACE_WARNING,
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      }),
      abort: () => {},
      progress,
    };
  }

  let aborted = false;
  let tickInterval: ReturnType<typeof setInterval> | undefined;

  function stopTickInterval() {
    if (tickInterval) {
      clearInterval(tickInterval);
      tickInterval = undefined;
    }
  }

  const promise = context.shell
    .execute(sanitizedCommand, {
      toolRequestId: request.id,
      onOutput: (line) => {
        progress.liveOutput.push(line);
        context.requestRender();
      },
      onStart: () => {
        stopTickInterval();
        progress.liveOutput.length = 0;
        progress.startTime = Date.now();
        tickInterval = setInterval(() => {
          context.requestRender();
        }, 1000);
      },
    })
    .then((result): ProviderToolResult => {
      if (aborted) {
        stopTickInterval();
        const { formattedOutput } = formatOutputForToolResult(
          result.output,
          result.exitCode,
          result.signal,
          result.durationMs,
          result.logFilePath,
        );
        const error = formattedOutput
          ? `Request was aborted by the user.\n\nOutput before termination:\n${formattedOutput}`
          : "Request was aborted by the user.";
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error,
          },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        };
      }
      stopTickInterval();

      const formatted = formatOutputForToolResult(
        result.output,
        result.exitCode,
        result.signal,
        result.durationMs,
        result.logFilePath,
      );
      const wasAbbreviated = formatted.wasAbbreviated;
      const formattedOutput = wasTrimmed
        ? formatted.formattedOutput + TRIM_REMINDER
        : formatted.formattedOutput;

      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: [
            {
              type: "text",
              text: formattedOutput,
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            },
          ],
          structuredResult: {
            toolName: "bash_command" as const,
            exitCode: result.exitCode,
            signal: result.signal ? String(result.signal) : undefined,
            logFilePath: result.logFilePath,
            logFileLineCount: result.logFilePath
              ? result.output.length
              : undefined,
            logFileCharCount: result.logFilePath
              ? result.output.reduce(
                  (acc, line) => acc + line.text.length + 1,
                  0,
                )
              : undefined,
            outputText: formattedOutput.replace(
              /\n?⚠️ {2}the result was abbreviated\. To see full output \([^)]*\): .+$/m,
              "",
            ),
            wasAbbreviated,
          },
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      };
    })
    .catch((error: Error): ProviderToolResult => {
      if (aborted) {
        stopTickInterval();
        const durationMs = progress.startTime
          ? Date.now() - progress.startTime
          : 0;
        const formattedOutput =
          progress.liveOutput.length > 0
            ? formatOutputForToolResult(
                progress.liveOutput,
                1,
                undefined,
                durationMs,
                undefined,
              ).formattedOutput
            : "";
        const errorMsg = formattedOutput
          ? `Request was aborted by the user.\n\nOutput before termination:\n${formattedOutput}`
          : "Request was aborted by the user.";
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: errorMsg,
          },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
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
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
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
