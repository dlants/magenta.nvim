import type {
  DisplayContext,
  NvimLua,
  ToolRequest as UnionToolRequest,
} from "@magenta/server";
import { d, type VDOMNode, withCode } from "../tea/view.ts";

type Input = NvimLua.Input;

const PREVIEW_MAX_LINES = 5;
const PREVIEW_MAX_LINE_LENGTH = 80;

function abridgeCode(code: string): string {
  const lines = code.split("\n");
  const preview = lines
    .slice(0, PREVIEW_MAX_LINES)
    .map((line) =>
      line.length > PREVIEW_MAX_LINE_LENGTH
        ? `${line.substring(0, PREVIEW_MAX_LINE_LENGTH)}...`
        : line,
    );
  if (lines.length > PREVIEW_MAX_LINES) {
    preview.push(`... (${lines.length - PREVIEW_MAX_LINES} more lines)`);
  }
  return preview.join("\n");
}

export function renderSummary(
  _request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  return d`🌙 nvim_lua`;
}

export function renderInput(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
  expanded: boolean,
): VDOMNode | undefined {
  const input = request.input as Input;
  if (expanded) {
    return withCode(d`${input.code}`);
  }
  return withCode(d`${abridgeCode(input.code)}`);
}
