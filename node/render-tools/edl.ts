import { d, withCode, type VDOMNode } from "../tea/view.ts";
import type {
  CompletedToolInfo,
  DisplayContext,
  ToolRequest as UnionToolRequest,
} from "../tools/types.ts";
import { EDL_DISPLAY_PREFIX, type EdlDisplayData } from "../tools/edl.ts";

type Input = {
  script: string;
};

const PREVIEW_MAX_LINES = 10;
const PREVIEW_MAX_LINE_LENGTH = 80;

function abridgeScript(script: string): string {
  const lines = script.split("\n");
  const preview = lines
    .slice(0, PREVIEW_MAX_LINES)
    .map((line) =>
      line.length > PREVIEW_MAX_LINE_LENGTH
        ? line.substring(0, PREVIEW_MAX_LINE_LENGTH) + "..."
        : line,
    );
  if (lines.length > PREVIEW_MAX_LINES) {
    preview.push(`... (${lines.length - PREVIEW_MAX_LINES} more lines)`);
  }
  return preview.join("\n");
}

function isError(result: CompletedToolInfo["result"]): boolean {
  return result.result.status === "error";
}

function getStatusEmoji(result: CompletedToolInfo["result"]): string {
  return isError(result) ? "❌" : "✅";
}

function extractEdlDisplayData(
  info: CompletedToolInfo,
): EdlDisplayData | undefined {
  if (info.result.result.status !== "ok") return undefined;
  const content = info.result.result.value;
  for (const item of content) {
    if (item.type === "text" && item.text.startsWith(EDL_DISPLAY_PREFIX)) {
      try {
        return JSON.parse(
          item.text.slice(EDL_DISPLAY_PREFIX.length),
        ) as EdlDisplayData;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function extractFormattedResult(info: CompletedToolInfo): string {
  if (info.result.result.status !== "ok") {
    return info.result.result.error;
  }
  const content = info.result.result.value;
  for (const item of content) {
    if (item.type === "text" && !item.text.startsWith(EDL_DISPLAY_PREFIX)) {
      return item.text;
    }
  }
  return "";
}

export function renderInFlightSummary(
  _request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  return d`📝⚙️ edl script executing...`;
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const status = getStatusEmoji(info.result);
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
    const fileErrorCount = data.fileErrorCount;
    const errorSuffix =
      fileErrorCount > 0
        ? ` (${String(fileErrorCount)} file error${fileErrorCount !== 1 ? "s" : ""})`
        : "";
    return d`📝${status} edl: ${String(totalMutations)} mutations in ${String(filesCount)} file${filesCount !== 1 ? "s" : ""}${errorSuffix}`;
  }

  return d`📝${status} edl script`;
}

export function renderCompletedPreview(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const abridged = abridgeScript(input.script);
  const scriptBlock = withCode(d`\`\`\`
${abridged}
\`\`\``);
  const data = extractEdlDisplayData(info);
  if (!data || isError(info.result)) return scriptBlock;

  const lines: string[] = [];

  for (const { path, summary } of data.mutations) {
    const parts: string[] = [];
    if (summary.replacements > 0) parts.push(`${summary.replacements} replace`);
    if (summary.insertions > 0) parts.push(`${summary.insertions} insert`);
    if (summary.deletions > 0) parts.push(`${summary.deletions} delete`);
    lines.push(
      `  ${path}: ${parts.join(", ")} (+${summary.linesAdded}/-${summary.linesRemoved})`,
    );
  }

  if (data.finalSelectionCount != undefined) {
    lines.push(
      `  Final selection: ${data.finalSelectionCount} range${data.finalSelectionCount !== 1 ? "s" : ""}`,
    );
  }

  return d`${scriptBlock}
${lines.join("\n")}`;
}

export function renderCompletedDetail(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const scriptBlock = withCode(d`\`\`\`
${input.script}
\`\`\``);
  return d`${scriptBlock}
${extractFormattedResult(info)}`;
}