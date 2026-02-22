import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { CompletedToolInfo } from "./types.ts";
import type { ToolName, GenericToolRequest, ToolInvocation } from "./types.ts";

export type Input = {
  result: string;
};

export type ToolRequest = GenericToolRequest<"yield_to_parent", Input>;

export function execute(request: ToolRequest): ToolInvocation {
  return {
    promise: Promise.resolve({
      type: "tool_result" as const,
      id: request.id,
      result: {
        status: "ok" as const,
        value: [{ type: "text" as const, text: request.input.result }],
      },
    }),
    abort: () => {},
  };
}

export function renderInFlightSummary(
  request: import("./types.ts").ToolRequest,
  _displayContext: import("./types.ts").DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  const resultPreview =
    input.result?.length > 50
      ? input.result.substring(0, 50) + "..."
      : (input.result ?? "");
  return d`↩️⚙️ yield_to_parent: ${resultPreview}`;
}
function isError(result: ProviderToolResult): boolean {
  return result.result.status === "error";
}

function getStatusEmoji(result: ProviderToolResult): string {
  return isError(result) ? "❌" : "✅";
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

export const spec: ProviderToolSpec = {
  name: "yield_to_parent" as ToolName,
  description: `\
Yield results to the parent agent.

CRITICAL: You MUST use this tool when your task is complete, or the parent agent will never receive your results.

Make sure you address every part of the original prompt you were given.
The parent agent can only observe your final yield message - none of the rest of the text is visible to the parent.
After using this tool, the sub-agent thread will be terminated.`,
  input_schema: {
    type: "object",
    properties: {
      result: {
        type: "string",
        description: "The result or information to return to the parent agent",
      },
    },
    required: ["result"],
  },
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.result != "string") {
    return {
      status: "error",
      error: `expected req.input.result to be a string but it was ${JSON.stringify(input.result)}`,
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
