import { PLACEHOLDER_NATIVE_MESSAGE_IDX, type ProviderToolSpec } from "../providers/provider-types.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolName,
} from "../tool-types.ts";
import type { Result } from "../utils/result.ts";

export type Input = {
  result: string;
};

export type StructuredResult = { toolName: "yield_to_parent" };

export type ToolRequest = GenericToolRequest<"yield_to_parent", Input>;

export function execute(request: ToolRequest): ToolInvocation {
  return {
    promise: Promise.resolve({
      type: "tool_result" as const,
      id: request.id,
      result: {
        status: "ok" as const,
        value: [{ type: "text" as const, text: request.input.result, nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }],
        structuredResult: { toolName: "yield_to_parent" as const },
      },
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    }),
    abort: () => {},
  };
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
  if (typeof input.result !== "string") {
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
