import type {
  CompletedToolInfo,
  DisplayContext,
  ToolRequest as UnionToolRequest,
} from "@magenta/server";
import { d, type VDOMNode, withInlineCode } from "../tea/view.ts";
import {
  displayPath,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";

type Input = {
  filePath: UnresolvedFilePath;
  symbol: string;
};

export function renderSummary(
  request: UnionToolRequest,
  displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  const absFilePath = resolveFilePath(
    displayContext.cwd,
    input.filePath,
    displayContext.homeDir,
  );
  const pathForDisplay = displayPath(
    displayContext.cwd,
    absFilePath,
    displayContext.homeDir,
  );
  return d`🔍 ${withInlineCode(d`\`${input.symbol}\``)} in ${withInlineCode(d`\`${pathForDisplay}\``)}`;
}

export function renderResultSummary(
  info: CompletedToolInfo,
  _displayContext: DisplayContext,
): VDOMNode {
  const result = info.result.result;
  if (result.status === "error") {
    return d`${result.error}`;
  }

  let refCount = 0;
  for (const content of result.value) {
    if (content.type === "text") {
      refCount += content.text
        .split("\n")
        .filter((l) => l.trim().length > 0).length;
    }
  }
  return d`${refCount.toString()} references`;
}
