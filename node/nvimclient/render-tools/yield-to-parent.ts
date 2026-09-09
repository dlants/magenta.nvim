import type {
  CompletedToolInfo,
  DisplayContext,
  ToolRequest as UnionToolRequest,
} from "@magenta/server";
import { d, type VDOMNode } from "../tea/view.ts";

type Input = {
  result: string;
};

export function renderSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  const resultPreview =
    input.result?.length > 50
      ? `${input.result.substring(0, 50)}...`
      : (input.result ?? "");
  return d`↩️ yield_to_parent: ${resultPreview}`;
}

export function renderResultSummary(_info: CompletedToolInfo): VDOMNode {
  return d``;
}
