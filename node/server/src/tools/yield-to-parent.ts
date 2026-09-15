import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderToolSpec,
} from "../providers/provider-types.ts";
import type {
  ExecutingToolInvocation,
  GenericToolRequest,
  ToolName,
} from "../tool-types.ts";
import type { Result } from "../utils/result.ts";

export type Input = Record<string, unknown>;

export type ToolRequest = GenericToolRequest<"yield_to_parent", Input>;

export function execute(request: ToolRequest): ExecutingToolInvocation {
  return {
    promise: Promise.resolve({
      type: "tool_result" as const,
      id: request.id,
      result: {
        status: "ok" as const,
        value: [
          {
            type: "text" as const,
            // The model just wrote the yielded text; echoing it back only
            // spends tokens.
            text: "Yield acknowledged.",
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          },
        ],
      },
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    }),
    abort: () => {},
  };
}

const DEFAULT_INPUT_SCHEMA: JSONSchemaType = {
  type: "object",
  properties: {
    result: {
      type: "string",
      description: "The result or information to return to the parent agent",
    },
  },
  required: ["result"],
};

export function getSpec(yieldSchema?: JSONSchemaType): ProviderToolSpec {
  return {
    ...spec,
    input_schema: yieldSchema ?? DEFAULT_INPUT_SCHEMA,
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
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { status: "error", error: "expected yield input to be an object" };
  }
  return {
    status: "ok",
    value: input,
  };
}
