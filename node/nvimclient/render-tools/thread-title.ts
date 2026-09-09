import type {
  CompletedToolInfo,
  DisplayContext,
  ToolRequest as UnionToolRequest,
} from "@magenta/server";
import { d, type VDOMNode } from "../tea/view.ts";

type Input = {
  title: string;
};

export function renderSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  return d`📝 Setting thread title: "${input.title}"`;
}

export function renderResultSummary(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  return d`"${input.title ?? ""}"`;
}
