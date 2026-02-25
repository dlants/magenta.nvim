import { type Result } from "../utils/result.ts";
import type {
  ToolInvocation,
  GenericToolRequest,
  ToolName,
} from "../tool-types.ts";
import type { DiagnosticsProvider } from "../capabilities/diagnostics-provider.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider-types.ts";

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
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
        };
      }
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: [{ type: "text", text: content }],
        },
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
        };
      }
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: `Failed to get diagnostics: ${error instanceof Error ? error.message : String(error)}`,
        },
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
