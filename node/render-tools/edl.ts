import type {
  CompletedToolInfo,
  DisplayContext,
  Edl,
  ToolRequestId,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";
import type { Msg as ThreadMsg, ToolViewState } from "../chat/thread.ts";
import type { Dispatch } from "../tea/tea.ts";
import {
  d,
  type VDOMNode,
  withBindings,
  withCode,
  withError,
  withInlineCode,
  withMuted,
} from "../tea/view.ts";
import {
  displayPath,
  type HomeDir,
  type NvimCwd,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";

type Input = {
  script: string;
};

const PREVIEW_MAX_LINES = 10;
const PREVIEW_MAX_LINE_LENGTH = 80;

function abridgeScript(script: string): string {
  const lines = script.split("\n");
  const preview = lines
    .slice(-PREVIEW_MAX_LINES)
    .map((line) =>
      line.length > PREVIEW_MAX_LINE_LENGTH
        ? `${line.substring(0, PREVIEW_MAX_LINE_LENGTH)}...`
        : line,
    );
  if (lines.length > PREVIEW_MAX_LINES) {
    preview.unshift(`... (${lines.length - PREVIEW_MAX_LINES} more lines)`);
  }
  return preview.join("\n");
}

function isError(result: CompletedToolInfo["result"]): boolean {
  return result.result.status === "error";
}

function extractEdlDisplayData(
  info: CompletedToolInfo,
): Edl.EdlDisplayData | undefined {
  if (info.structuredResult.toolName === "edl") {
    return (info.structuredResult as Edl.StructuredResult).displayData;
  }
  return undefined;
}

function extractFormattedResult(info: CompletedToolInfo): string {
  if (info.structuredResult.toolName === "edl") {
    return (info.structuredResult as Edl.StructuredResult).formattedResult;
  }
  if (info.result.result.status !== "ok") {
    return info.result.result.error;
  }
  return "";
}

export function renderSummary(
  _request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  return d`📝 edl script`;
}

export function renderInput(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
  expanded: boolean,
  inFlight: boolean,
): VDOMNode | undefined {
  const input = request.input as Input;
  if (expanded) {
    return withCode(d`${input.script}`);
  }
  // Once the tool has finished, hide the streaming preview so the request
  // collapses to a single line. The raw script remains available via the
  // input-summary expansion.
  if (!inFlight) {
    return undefined;
  }
  const abridged = abridgeScript(input.script);
  return withCode(d`${abridged}`);
}

export function renderInputSummary(request: UnionToolRequest): VDOMNode {
  const input = request.input as Input;
  return withCode(d`${input.script}`);
}

export function renderResultSummaryExpansion(
  info: CompletedToolInfo,
): VDOMNode {
  return withCode(d`${extractFormattedResult(info)}`);
}

export function renderResultSummary(info: CompletedToolInfo): VDOMNode {
  const data = extractEdlDisplayData(info);

  if (data) {
    const totalMutations = data.mutations.reduce(
      (acc, m) =>
        acc +
        m.summary.replacements +
        m.summary.insertions +
        m.summary.deletions,
      0,
    );
    const filesCount = data.mutations.length;
    const failedCommandCount = data.fileErrors.reduce(
      (acc, fe) => acc + fe.failedCommands.length,
      0,
    );
    const errorSuffix =
      failedCommandCount > 0
        ? ` (${String(failedCommandCount)} command${failedCommandCount !== 1 ? "s" : ""} failed)`
        : "";
    const totalLinesAdded = data.mutations.reduce(
      (acc, m) => acc + m.summary.linesAdded,
      0,
    );
    const totalLinesRemoved = data.mutations.reduce(
      (acc, m) => acc + m.summary.linesRemoved,
      0,
    );
    return d`edl: ${String(totalMutations)} mutations in ${String(filesCount)} file${filesCount !== 1 ? "s" : ""}, +${String(totalLinesAdded)}/-${String(totalLinesRemoved)} lines${errorSuffix}`;
  }

  return d`edl script`;
}

function renderTrace(data: Edl.EdlDisplayData): VDOMNode {
  const lines: VDOMNode[] = [];

  if (data.trace.length > 0) {
    lines.push(withMuted(d`Trace:\n`));
    for (const t of data.trace) {
      lines.push(d`  ${withInlineCode(d`${t.command}`)} → ${t.snippet}\n`);
    }
  }

  if (data.fileErrors.length > 0) {
    if (lines.length > 0) lines.push(d`\n`);
    lines.push(withMuted(d`Errors:\n`));
    for (const fe of data.fileErrors) {
      lines.push(
        d`  ❌ ${withInlineCode(d`${fe.path}`)} ${withError(d`(${String(fe.failedCommands.length)} command${fe.failedCommands.length !== 1 ? "s" : ""} failed)`)}: ${fe.error}\n`,
      );
      for (const cmd of fe.failedCommands) {
        lines.push(withCode(d`${cmd}\n`));
      }
    }
  }

  if (lines.length === 0) {
    lines.push(withMuted(d`(no trace)\n`));
  }

  return d`${lines}`;
}

export function renderResult(
  info: CompletedToolInfo,
  context: {
    threadDispatch: Dispatch<ThreadMsg>;
    cwd: NvimCwd;
    homeDir: HomeDir;
  },
  toolViewState: ToolViewState,
  toolRequestId: ToolRequestId,
): VDOMNode | undefined {
  const expanded = toolViewState.resultExpanded;
  const data = extractEdlDisplayData(info);

  const toggleExpanded = () =>
    context.threadDispatch({
      type: "toggle-tool-result",
      toolRequestId,
    });

  if (!data || isError(info.result)) {
    if (expanded) {
      return withBindings(withCode(d`${extractFormattedResult(info)}`), {
        "=": toggleExpanded,
      });
    }
    return undefined;
  }

  if (expanded) {
    return withBindings(renderTrace(data), { "=": toggleExpanded });
  }

  const rows: VDOMNode[] = [];

  for (const { path, summary } of data.mutations) {
    const parts: string[] = [];
    if (summary.replacements > 0) parts.push(`${summary.replacements} replace`);
    if (summary.insertions > 0) parts.push(`${summary.insertions} insert`);
    if (summary.deletions > 0) parts.push(`${summary.deletions} delete`);

    const absPath = resolveFilePath(
      context.cwd,
      path as UnresolvedFilePath,
      context.homeDir,
    );
    const shownPath = displayPath(context.cwd, absPath, context.homeDir);

    rows.push(
      withBindings(
        d`${withInlineCode(d`${shownPath}`)} ${parts.join(", ")} ${withMuted(d`(+${String(summary.linesAdded)}/-${String(summary.linesRemoved)})`)}\n`,
        {
          "<CR>": () =>
            context.threadDispatch({
              type: "open-edit-file",
              filePath: path as UnresolvedFilePath,
            }),
          "=": toggleExpanded,
        },
      ),
    );
  }

  for (const { path, error, failedCommands } of data.fileErrors) {
    const absPath = resolveFilePath(
      context.cwd,
      path as UnresolvedFilePath,
      context.homeDir,
    );
    const shownPath = displayPath(context.cwd, absPath, context.homeDir);

    rows.push(
      withBindings(
        d`❌ ${withInlineCode(d`${shownPath}`)} ${withError(d`${String(failedCommands.length)} command${failedCommands.length !== 1 ? "s" : ""} failed`)}: ${error}\n${failedCommands.map((cmd) => withCode(d`${cmd}\n`))}`,
        {
          "<CR>": () =>
            context.threadDispatch({
              type: "open-edit-file",
              filePath: path as UnresolvedFilePath,
            }),
          "=": toggleExpanded,
        },
      ),
    );
  }

  if (data.finalSelectionCount !== undefined) {
    rows.push(
      withBindings(
        withMuted(
          d`Final selection: ${String(data.finalSelectionCount)} range${data.finalSelectionCount !== 1 ? "s" : ""}\n`,
        ),
        { "=": toggleExpanded },
      ),
    );
  }

  if (rows.length === 0) return undefined;

  return d`${rows}`;
}
