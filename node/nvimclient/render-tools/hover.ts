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
  context?: string;
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
  return d`🔍 hover ${withInlineCode(d`\`${input.symbol}\``)} in ${withInlineCode(d`\`${pathForDisplay}\``)}`;
}

export function renderResultSummary(
  _info: CompletedToolInfo,
  _displayContext: DisplayContext,
): VDOMNode {
  return d``;
}
