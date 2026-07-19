import type {
  CompletedToolInfo,
  DisplayContext,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";
import { d, type VDOMNode, withInlineCode } from "../tea/view.ts";
import {
  displayPath,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";

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

function formatFilesDisplay(
  input: Input,
  displayContext: DisplayContext,
): VDOMNode {
  return d`${input.files.map(
    (file) => d`\n  ${formatFileDisplay(file, displayContext)}`,
  )}`;
}

export function renderSummary(
  request: UnionToolRequest,
  displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  return d`👀${formatFilesDisplay(input, displayContext)}`;
}

export function renderResultSummary(
  info: CompletedToolInfo,
  displayContext: DisplayContext,
): VDOMNode {
  const result = info.result.result;

  if (result.status === "error") {
    return d`${result.error}`;
  }

  return formatFilesDisplay(info.request.input as Input, displayContext);
}
