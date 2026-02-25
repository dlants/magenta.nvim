import { d, withInlineCode, type VDOMNode } from "../tea/view.ts";
import {
  resolveFilePath,
  displayPath,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import type {
  DisplayContext,
  CompletedToolInfo,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";

type Input = {
  filePath: UnresolvedFilePath;
  symbol: string;
};

export function renderInFlightSummary(
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
  return d`🔍⚙️ ${withInlineCode(d`\`${input.symbol}\``)} in ${withInlineCode(d`\`${pathForDisplay}\``)}`;
}

export function renderCompletedSummary(
  info: CompletedToolInfo,
  displayContext: DisplayContext,
): VDOMNode {
  const input = info.request.input as Input;
  const status = info.result.result.status === "error" ? "❌" : "✅";
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
  return d`🔍${status} ${withInlineCode(d`\`${input.symbol}\``)} in ${withInlineCode(d`\`${pathForDisplay}\``)}`;
}
