import type {
  DisplayContext,
  Reply,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";
import { d, type VDOMNode, withCode } from "../tea/view.ts";

type Input = Reply.Input;

export function renderSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  const ids = input.replies.map((r) => r.commentId).join(", ");
  return d`💬 reply: ${ids}`;
}

export function renderInput(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
  expanded: boolean,
): VDOMNode | undefined {
  if (!expanded) {
    return undefined;
  }
  const input = request.input as Input;
  const body = input.replies.map((r) => `${r.commentId}: ${r.text}`).join("\n");
  return withCode(d`${body}`);
}
