import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
} from "../agent/provider-types.ts";
import type { StaticTool, ToolName, ToolMsg } from "./types.ts";
import type { ToolRequest, Input } from "./specs/bash-command.ts";
import type { CommandExec, CommandResult, OutputChunk } from "./environment.ts";
import type { Logger } from "../logger.ts";
import type { Cwd } from "../utils/files.ts";
import type { AbsFilePath } from "../utils/files.ts";
import type { Dispatch } from "../tea/tea.ts";

export const MAX_OUTPUT_TOKENS_FOR_AGENT = 2000;
export const MAX_CHARS_PER_LINE = 800;
export const CHARACTERS_PER_TOKEN = 4;

export type OutputLine = {
  stream: "stdout" | "stderr";
  text: string;
};

export type State =
  | { state: "processing"; output: OutputLine[] }
  | { state: "done"; output: OutputLine[]; result: ProviderToolResult };

export type Msg = {
  type: "finish";
  result: Result<ProviderToolResultContent[]>;
};

export type BashCommandToolContext = {
  commandExec: CommandExec;
  logger: Logger;
  cwd: Cwd;
  myDispatch: Dispatch<Msg>;
};

export function abbreviateLine(text: string): string {
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

export function formatOutputForToolResult(
  result: CommandResult,
  output: OutputLine[],
): ProviderToolResultContent[] {
  const totalLines = output.length;
  const totalBudgetChars = MAX_OUTPUT_TOKENS_FOR_AGENT * CHARACTERS_PER_TOKEN;

  let totalRawChars = 0;
  for (const line of output) {
    totalRawChars += line.text.length + 1;
  }

  // If under budget, return as-is without any abbreviation
  if (totalRawChars <= totalBudgetChars) {
    let formattedOutput = "";
    let currentStream: "stdout" | "stderr" | undefined = undefined;

    for (const line of output) {
      if (currentStream !== line.stream) {
        formattedOutput += line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
        currentStream = line.stream;
      }
      formattedOutput += line.text + "\n";
    }

    if (result.signal) {
      formattedOutput += `terminated by signal ${result.signal}\n`;
    } else {
      formattedOutput += `exit code ${result.exitCode}\n`;
    }

    if (result.logFile) {
      formattedOutput += `\nFull output (${totalLines} lines): ${result.logFile}`;
    }

    return [{ type: "text", text: formattedOutput }];
  }

  // Over budget - need to abbreviate lines and omit from the middle
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
  let currentStream: "stdout" | "stderr" | undefined = undefined;

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

  if (result.signal) {
    formattedOutput += `terminated by signal ${result.signal}\n`;
  } else {
    formattedOutput += `exit code ${result.exitCode}\n`;
  }

  if (result.logFile) {
    formattedOutput += `\nFull output (${totalLines} lines): ${result.logFile}`;
  }

  return [{ type: "text", text: formattedOutput }];
}

export class BashCommandTool implements StaticTool {
  state: State;
  toolName = "bash_command" as unknown as ToolName;
  aborted: boolean = false;
  private abortController: AbortController;

  constructor(
    public request: ToolRequest,
    public context: BashCommandToolContext,
  ) {
    this.abortController = new AbortController();
    this.state = { state: "processing", output: [] };

    setTimeout(() => {
      this.executeCommand().catch((error) => {
        this.context.logger.error(
          `Error executing bash command: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  isPendingUserAction(): boolean {
    return false;
  }

  abort(): ProviderToolResult {
    if (this.state.state === "done") {
      return this.getToolResult();
    }

    this.aborted = true;
    this.abortController.abort();

    const result: ProviderToolResult = {
      type: "tool_result",
      id: this.request.id,
      result: {
        status: "error",
        error: "Request was aborted by the user.",
      },
    };

    this.state = { state: "done", output: this.state.output, result };
    return result;
  }

  update(msg: ToolMsg) {
    const m = msg as unknown as Msg;
    switch (m.type) {
      case "finish":
        if (this.state.state === "processing") {
          this.state = {
            state: "done",
            output: this.state.output,
            result: {
              type: "tool_result",
              id: this.request.id,
              result: m.result,
            },
          };
        }
        return;

      default:
        assertUnreachable(m as never);
    }
  }

  private async executeCommand() {
    const command = this.request.input.command;
    const output = this.state.state === "processing" ? this.state.output : [];

    const onOutput = (chunk: OutputChunk) => {
      output.push({ stream: chunk.stream, text: chunk.text });
    };

    const spawnResult = await this.context.commandExec.spawn(command, {
      cwd: this.context.cwd as unknown as AbsFilePath,
      timeout: 300_000,
      abortSignal: this.abortController.signal,
      onOutput,
    });

    if (this.aborted) return;

    if (spawnResult.status === "ok") {
      const content = formatOutputForToolResult(spawnResult.value, output);
      this.context.myDispatch({
        type: "finish",
        result: { status: "ok", value: content },
      });
    } else {
      this.context.myDispatch({
        type: "finish",
        result: { status: "error", error: spawnResult.error },
      });
    }
  }

  getToolResult(): ProviderToolResult {
    switch (this.state.state) {
      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: "This tool use is being processed. Please proceed with your answer or address other parts of the question.",
              },
            ],
          },
        };
      case "done":
        return this.state.result;
      default:
        assertUnreachable(this.state);
    }
  }
}
