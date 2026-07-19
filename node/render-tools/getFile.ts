import type {
  CompletedToolInfo,
  DisplayContext,
  ProviderToolResultContent,
  ToolRequestId,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";
import type { ToolViewState } from "../chat/thread.ts";
import type { Dispatch } from "../tea/tea.ts";
import {
  d,
  type VDOMNode,
  withBindings,
  withCode,
  withInlineCode,
} from "../tea/view.ts";
import {
  displayPath,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import { formatTokens } from "../utils/tokens.ts";

export type RenderContext = {
  cwd: DisplayContext["cwd"];
  homeDir: DisplayContext["homeDir"];
  threadDispatch: Dispatch<{
    type: "toggle-tool-result-item";
    toolRequestId: ToolRequestId;
    itemKey: string;
  }>;
};

type FileRequest = {
  filePath: UnresolvedFilePath;
  force?: boolean;
  pdfPage?: number;
  startLine?: number;
  numLines?: number;
};

type Input = {
  files: FileRequest[];
};

function formatFileDisplay(
  file: FileRequest,
  displayContext: DisplayContext,
): VDOMNode {
  const absFilePath = resolveFilePath(
    displayContext.cwd,
    file.filePath,
    displayContext.homeDir,
  );
  const pathForDisplay = displayPath(
    displayContext.cwd,
    absFilePath,
    displayContext.homeDir,
  );
  let extraInfo = "";
  if (file.pdfPage !== undefined) {
    extraInfo = ` (page ${file.pdfPage})`;
  } else if (file.startLine !== undefined || file.numLines !== undefined) {
    const start = file.startLine ?? 1;
    const num = file.numLines;
    extraInfo =
      num !== undefined
        ? ` (lines ${start}-${start + num - 1})`
        : ` (from line ${start})`;
  }
  return withInlineCode(d`\`${pathForDisplay}\`${extraInfo}`);
}

export function renderSummary(
  request: UnionToolRequest,
  displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  if (input.files.length === 1) {
    return d`👀 ${formatFileDisplay(input.files[0], displayContext)}`;
  }
  return d`👀${input.files.map(
    (file) => d`\n  ${formatFileDisplay(file, displayContext)}`,
  )}`;
}

/** Split the result content blocks into per-file groups, delimited by the
 * `=== <path> ===` header block that precedes each file's content. */
function groupBlocksByFile(
  value: ProviderToolResultContent[],
): ProviderToolResultContent[][] {
  const groups: ProviderToolResultContent[][] = [];
  for (const block of value) {
    if (
      block.type === "text" &&
      /^=== .* ===$/.test(block.text.split("\n")[0])
    ) {
      groups.push([]);
    } else if (groups.length > 0) {
      groups[groups.length - 1].push(block);
    }
  }
  return groups;
}

export function renderResultSummary(
  info: CompletedToolInfo,
  displayContext: DisplayContext,
): VDOMNode {
  const result = info.result.result;

  if (result.status === "error") {
    return d`❌ ${result.error}`;
  }

  const input = info.request.input as Input;
  const structured = info.structuredResult;
  const perFileStatus =
    structured.toolName === "get_files" && "files" in structured
      ? structured.files
      : [];
  const groups = groupBlocksByFile(result.value);

  return d`${input.files.map((file, i) => {
    const emoji = perFileStatus[i]?.isError ? "❌" : "✅";
    const group = groups[i] ?? [];
    const tokEst = formatTokens(JSON.stringify(group).length);
    return d`${i > 0 ? "\n" : ""}${emoji} ${formatFileDisplay(file, displayContext)} (${tokEst})`;
  })}`;
}

/** Render the content blocks of a single file as they were sent to the agent
 * (raw text, not JSON-escaped). Non-text blocks become a short placeholder. */
function renderSentContent(blocks: ProviderToolResultContent[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "image":
          return "[image]";
        case "document":
          return `[document${block.title ? `: ${block.title}` : ""}]`;
        default:
          return "";
      }
    })
    .join("\n");
}

export function renderResult(
  info: CompletedToolInfo,
  context: RenderContext,
  toolViewState: ToolViewState,
  toolRequestId: ToolRequestId,
): VDOMNode | undefined {
  const result = info.result.result;

  if (result.status === "error") {
    return d`❌ ${result.error}`;
  }

  const displayContext: DisplayContext = {
    cwd: context.cwd,
    homeDir: context.homeDir,
  };
  const input = info.request.input as Input;
  const structured = info.structuredResult;
  const perFileStatus =
    structured.toolName === "get_files" && "files" in structured
      ? structured.files
      : [];
  const groups = groupBlocksByFile(result.value);

  return d`${input.files.map((file, i) => {
    const emoji = perFileStatus[i]?.isError ? "❌" : "✅";
    const group = groups[i] ?? [];
    const tokEst = formatTokens(JSON.stringify(group).length);
    const itemKey = String(i);
    const expanded = toolViewState.resultItemExpanded?.[itemKey] ?? false;
    const line = withBindings(
      d`${i > 0 ? "\n" : ""}${emoji} ${formatFileDisplay(file, displayContext)} (${tokEst})`,
      {
        "=": () =>
          context.threadDispatch({
            type: "toggle-tool-result-item",
            toolRequestId,
            itemKey,
          }),
      },
    );
    const detail = expanded
      ? d`\n${withCode(d`${renderSentContent(group)}`)}`
      : d``;
    return d`${line}${detail}`;
  })}`;
}
