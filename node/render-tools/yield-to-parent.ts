import { d, type VDOMNode } from "../tea/view.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";
import type {
  DisplayContext,
  CompletedToolInfo,
  ToolRequest as UnionToolRequest,
} from "@magenta/core";

type Input = {
  result: string;
};

function isError(result: ProviderToolResult): boolean {
  return result.result.status === "error";
}

function getStatusEmoji(result: ProviderToolResult): string {
  return isError(result) ? "❌" : "✅";
}

export function renderInFlightSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  const resultPreview =
    input.result?.length > 50
      ? input.result.substring(0, 50) + "..."
      : (input.result ?? "");
  return d`↩️⚙️ yield_to_parent: ${resultPreview}`;
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const status = getStatusEmoji(info.result);
  const resultPreview =
    input.result?.length > 50
      ? input.result.substring(0, 50) + "..."
      : (input.result ?? "");
  return d`↩️${status} yield_to_parent: ${resultPreview}`;
}
