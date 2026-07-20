import type {
  BashCommand,
  CompletedToolInfo,
  DisplayContext,
  ToolRequestId,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";
import type { OutputLine } from "../capabilities/shell.ts";
import type { ToolViewState } from "../chat/thread.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { MagentaOptions } from "../options.ts";
import type { Dispatch } from "../tea/tea.ts";
import {
  d,
  type VDOMNode,
  withBindings,
  withCode,
  withInlineCode,
} from "../tea/view.ts";
import type { HomeDir, NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import { formatTokens } from "../utils/tokens.ts";

type BashProgress = BashCommand.BashProgress;

import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";

type Input = {
  command: string;
};

export type RenderContext = {
  getDisplayWidth: () => number;
  nvim: Nvim;
  cwd: NvimCwd;
  homeDir: HomeDir;
  options: MagentaOptions;
  threadDispatch: Dispatch<{
    type: "toggle-tool-result";
    toolRequestId: ToolRequestId;
  }>;
};

export function renderSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  return d`⚡ ${withInlineCode(d`\`${input.command}\``)}`;
}

export function renderInput(
  _request: UnionToolRequest,
  _displayContext: DisplayContext,
  _expanded: boolean,
): VDOMNode | undefined {
  return undefined;
}

export function renderProgress(
  _request: UnionToolRequest,
  progress: BashProgress,
  context: RenderContext,
  expanded: boolean,
): VDOMNode | undefined {
  const timing =
    progress.startTime !== undefined
      ? d`(${String(Math.floor((Date.now() - progress.startTime) / 1000))}s / 300s) `
      : undefined;

  if (!expanded) {
    const formattedOutput = formatOutputPreview(
      progress.liveOutput,
      context.getDisplayWidth,
    );
    if (formattedOutput) {
      return d`${timing ?? d``}${withCode(d`${formattedOutput}`)}`;
    }
    return timing;
  }

  return d`${timing ?? d``}${renderOutputDetail(progress.liveOutput, undefined, context)}`;
}

export function renderResultSummary(info: CompletedToolInfo): VDOMNode {
  const result = info.result.result;

  if (result.status === "error") {
    return d`${result.error}`;
  }

  let exitCode: number | undefined;
  let signal: string | undefined;

  if (info.structuredResult.toolName === "bash_command") {
    const sr = info.structuredResult as BashCommand.StructuredResult;
    exitCode = sr.exitCode;
    signal = sr.signal;
  }

  if (signal) {
    return d`Terminated by ${signal}`;
  }

  if (exitCode !== undefined && exitCode !== 0) {
    return d`exit ${exitCode.toString()}`;
  }

  return d`exit 0`;
}

export function renderResult(
  info: CompletedToolInfo,
  context: RenderContext,
  toolViewState: ToolViewState,
  toolRequestId: ToolRequestId,
): VDOMNode | undefined {
  const expanded = toolViewState.resultExpanded;
  const content = expanded
    ? renderResultDetail(info, context)
    : renderResultPreview(info, context);
  if (!content) return undefined;
  return withBindings(content, {
    "=": () =>
      context.threadDispatch({
        type: "toggle-tool-result",
        toolRequestId,
      }),
  });
}

function renderResultPreview(
  info: CompletedToolInfo,
  context: RenderContext,
): VDOMNode | undefined {
  const result = info.result.result;

  if (result.status !== "ok" || result.value.length === 0) {
    return undefined;
  }

  const firstValue = result.value[0];
  if (firstValue.type !== "text") {
    return undefined;
  }

  const outputText =
    info.structuredResult.toolName === "bash_command"
      ? (info.structuredResult as BashCommand.StructuredResult).outputText
      : firstValue.text;
  const exitCode =
    info.structuredResult.toolName === "bash_command"
      ? (info.structuredResult as BashCommand.StructuredResult).exitCode
      : undefined;
  const logFileView =
    info.structuredResult.toolName === "bash_command"
      ? (() => {
          const sr = info.structuredResult as BashCommand.StructuredResult;
          return sr.wasAbbreviated &&
            sr.logFilePath &&
            sr.logFileCharCount !== undefined
            ? renderLogFileLinkDirect(
                sr.logFilePath,
                sr.logFileCharCount,
                context,
              )
            : d``;
        })()
      : d``;

  const lines = outputText.split("\n");
  const maxLines = 10;
  const maxLength = context.getDisplayWidth() - 5;

  let previewLines = lines.length > maxLines ? lines.slice(-maxLines) : lines;
  previewLines = previewLines.map((line) =>
    line.length > maxLength ? `${line.substring(0, maxLength)}...` : line,
  );

  const previewText = previewLines.join("\n");

  if (exitCode !== undefined && exitCode !== 0) {
    return d`❌ Exit code: ${exitCode.toString()}
${withCode(d`${previewText}`)}${logFileView}`;
  }

  return d`${withCode(d`${previewText}`)}${logFileView}`;
}

function renderResultDetail(
  info: CompletedToolInfo,
  context: RenderContext,
): VDOMNode | undefined {
  const input = info.request.input as Input;
  const result = info.result.result;

  if (result.status !== "ok" || result.value.length === 0) {
    return result.status === "error" ? d`❌ ${result.error}` : undefined;
  }

  const firstValue = result.value[0];
  if (firstValue.type !== "text") {
    return undefined;
  }

  const outputText =
    info.structuredResult.toolName === "bash_command"
      ? (info.structuredResult as BashCommand.StructuredResult).outputText
      : firstValue.text;
  const logFileView =
    info.structuredResult.toolName === "bash_command"
      ? (() => {
          const sr = info.structuredResult as BashCommand.StructuredResult;
          return sr.wasAbbreviated &&
            sr.logFilePath &&
            sr.logFileCharCount !== undefined
            ? renderLogFileLinkDirect(
                sr.logFilePath,
                sr.logFileCharCount,
                context,
              )
            : d``;
        })()
      : d``;

  return d`command: ${withInlineCode(d`\`${input.command}\``)}
${withCode(d`${outputText}`)}${logFileView}`;
}

function formatOutputPreview(
  output: OutputLine[],
  getDisplayWidth: () => number,
): string {
  let formattedOutput = "";
  let currentStream: "stdout" | "stderr" | null = null;
  const lastTenLines = output.slice(-10);

  for (const line of lastTenLines) {
    if (currentStream !== line.stream) {
      formattedOutput += line.stream === "stdout" ? "stdout:\n" : "stderr:\n";
      currentStream = line.stream;
    }
    const displayWidth = getDisplayWidth() - 5;
    const displayText =
      line.text.length > displayWidth
        ? `${line.text.substring(0, displayWidth)}...`
        : line.text;
    formattedOutput += `${displayText}\n`;
  }

  return formattedOutput;
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
    formattedOutput += `${line.text}\n`;
  }

  const charCount = output.reduce((acc, line) => acc + line.text.length + 1, 0);
  const logFileView = logFilePath
    ? renderLogFileLinkDirect(logFilePath, charCount, context)
    : d``;

  return d`${withCode(d`${formattedOutput}`)}${logFileView}`;
}

function renderLogFileLinkDirect(
  logFilePath: string,
  charCount: number,
  context: RenderContext,
): VDOMNode {
  return withBindings(
    d`\nFull output (${formatTokens(charCount)}): ${withInlineCode(d`\`${logFilePath}\``)}`,
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
