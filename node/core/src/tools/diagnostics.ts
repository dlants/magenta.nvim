import type { DiagnosticsProvider } from "../capabilities/diagnostics-provider.ts";
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

export type StructuredResult = { toolName: "diagnostics" };
export type Input = {};

export type ToolRequest = GenericToolRequest<"diagnostics", Input>;

export function execute(
  request: ToolRequest,
  context: {
    diagnosticsProvider: DiagnosticsProvider;
  },
): ToolInvocation {
  let aborted = false;

  const promise = (async (): Promise<ProviderToolResult> => {
    try {
      const content = await context.diagnosticsProvider.getDiagnostics();
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
          value: [{ type: "text", text: content, nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }],
          structuredResult: { toolName: "diagnostics" },
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
          error: `Failed to get diagnostics: ${error instanceof Error ? error.message : String(error)}`,
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
  name: "diagnostics" as ToolName,
  description: "Get all diagnostic messages in the workspace.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export function validateInput(): Result<Input> {
  return {
    status: "ok",
    value: {} as Input,
  };
}
