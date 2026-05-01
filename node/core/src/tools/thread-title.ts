import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "../providers/provider-types.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolName,
} from "../tool-types.ts";
import type { Result } from "../utils/result.ts";

export function execute(
  request: ToolRequest,
  _context: Record<string, never>,
): ToolInvocation {
  let aborted = false;

  const promise = (async (): Promise<ProviderToolResult> => {
    try {
      await Promise.resolve();
      if (aborted) {
                return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Request was aborted by the user.",
          },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        };

      }
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: [{ type: "text", text: request.input.title, nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }],
          structuredResult: { toolName: "thread_title" as const },
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      };
    } catch (error) {
      if (aborted) {
                return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Request was aborted by the user.",
          },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        };

      }
            return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: `Failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      };

    }
  })();

  return {
    promise,
    abort: () => {
      aborted = true;
    },
  };
}

export const spec: ProviderToolSpec = {
  name: "thread_title" as ToolName,
  description: `Set a title for the current conversation thread based on the user's message.`,
  input_schema: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description:
          "A short, descriptive title for the conversation thread. Should be shorter than 80 characters.",
      },
    },
    required: ["title"],
    additionalProperties: false,
  },
};

export type Input = {
  title: string;
};

export type ToolRequest = GenericToolRequest<"thread_title", Input>;
export type StructuredResult = { toolName: "thread_title" };

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.title !== "string") {
    return {
      status: "error",
      error: "expected req.input.title to be a string",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
