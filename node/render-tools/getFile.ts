import { d, type VDOMNode, withBindings } from "../tea/view.ts";
import {
  type DisplayContext,
  type ToolRequest,
} from "@magenta/core";
import type { CompletedToolInfo } from "@magenta/core";
import {
  type AbsFilePath,
  displayPath,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import { formatTokens } from "../utils/tokens.ts";
import type * as GetFile from "../../node/core/src/tools/getFile.ts";
import type { RenderContext } from "./index.ts";
import type { ToolViewState } from "../chat/thread.ts";
import type { ToolRequestId } from "@magenta/core";

type FileRequest = GetFile.FileRequest;
type Input = GetFile.Input;

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
  return d`\`${pathForDisplay}\`${extraInfo}`;
}

export function renderSummary(
  request: ToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;

  return d`👀 read ${input.files.length.toString()} ${input.files.length === 1 ? "file" : "files"}`;
}

function estimateTokens(text: string | undefined): string {
  if (!text) return "(0 tok)";
  return `(${formatTokens(text.length)})`;
}

type PerFileInfo = {
  fileDisplay: VDOMNode;
  isError: boolean;
  contentText: string;
};

function computeFileInfos(
  info: CompletedToolInfo,
  displayContext: DisplayContext,
): PerFileInfo[] | undefined {
  const result = info.result.result;
  if (result.status === "error") {
    return undefined;
  }

  const input = info.request.input as Input;
  const structured = (result as any).structuredResult as
    | GetFile.StructuredResult
    | undefined;

  if (!structured || structured.files.length === 0) {
    return undefined;
  }

  const headerIndices = result.value.reduce<number[]>(
    (acc, block: any, blockIdx: number) => {
      if (block.type === "text" && block.text.startsWith("=== ")) {
        acc.push(blockIdx);
      }
      return acc;
    },
    [],
  );

  return structured.files.map((file, idx) => {
    const request = input.files[idx];
    const fileDisplay = formatFileDisplay(request, displayContext);

    const contentStart = headerIndices[idx] + 1;
    const contentEnd = headerIndices[idx + 1] ?? result.value.length;
    const contentText = result.value
      .slice(contentStart, contentEnd)
      .map((block: any) => (block.type === "text" ? block.text : ""))
      .join("\n");

    return { fileDisplay, isError: file.isError, contentText };
  });
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
  const fileInfos = computeFileInfos(info, displayContext);

  if (!fileInfos) {
    return d`✅ (${input.files.length.toString()} files)`;
  }

  const fileLines = fileInfos.map(
    (file) =>
      d`${file.isError ? "❌" : "✅"} ${file.fileDisplay} ${estimateTokens(file.contentText)}`,
  );

  return d`${fileLines}`;
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
  const fileInfos = computeFileInfos(info, displayContext);
  if (!fileInfos) {
    return undefined;
  }

  const itemExpanded = toolViewState.resultItemExpanded || {};

  const fileLines = fileInfos.map((file, idx) => {
    const itemKey = idx.toString();
    const expanded = itemExpanded[itemKey];
    const header = d`${file.isError ? "❌" : "✅"} ${file.fileDisplay} ${estimateTokens(file.contentText)}`;
    const entry = expanded ? d`${header}\n${file.contentText}` : header;

    const prefix = idx === 0 ? d`` : d`\n`;
    return d`${prefix}${withBindings(entry, {
      "=": () =>
        context.threadDispatch({
          type: "toggle-tool-result-item",
          toolRequestId,
          itemKey,
        }),
    })}`;
  });

  return d`${fileLines}`;
}
