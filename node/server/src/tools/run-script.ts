import type {
  ScriptCatalogEntry,
  ScriptRunner,
} from "../capabilities/script-runner.ts";
import type { ThreadId } from "../chat-types.ts";
import type { ProviderToolSpec } from "../providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "../providers/provider-types.ts";
import type {
  ExecutedToolResult,
  ExecutingToolInvocation,
  GenericToolRequest,
  ToolName,
} from "../tool-types.ts";
import type { Result } from "../utils/result.ts";
import { validateAgainstSchema } from "../utils/validate-schema.ts";

export type Input = {
  scriptName: string;
  parameters?: Record<string, unknown>;
};

export type StructuredResult = { toolName: "run_script" };

export type ToolRequest = GenericToolRequest<"run_script", Input>;

export function getSpec(catalog: ScriptCatalogEntry[]): ProviderToolSpec {
  const descriptions = catalog
    .map((c) => `- ${c.name}: ${c.description}`)
    .join("\n");
  return {
    name: "run_script" as ToolName,
    description: `Trigger a project automation script. Scripts run outside this thread's lifecycle; they may spawn their own threads and report progress in the Scripts section of the overview.\n\nTwo-step protocol: first call with only \`scriptName\` to fetch that script's parameter schema, then call again with \`scriptName\` and a \`parameters\` object matching that schema to run it.\n\nAvailable scripts:\n${descriptions}`,
    input_schema: {
      type: "object",
      properties: {
        scriptName: {
          type: "string",
          enum: catalog.map((c) => c.name),
          description: "The name of the script to run.",
        },
        parameters: {
          type: "object",
          description:
            "Parameters for the script, matching the chosen script's parameter schema. Omit on the first call to fetch the schema; provide it on the second call to run the script.",
        },
      },
      required: ["scriptName"],
      additionalProperties: false,
    },
  };
}

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.scriptName !== "string") {
    return {
      status: "error",
      error: "expected req.input.scriptName to be a string",
    };
  }
  if (
    input.parameters !== undefined &&
    (typeof input.parameters !== "object" ||
      input.parameters === null ||
      Array.isArray(input.parameters))
  ) {
    return {
      status: "error",
      error: "expected req.input.parameters to be an object",
    };
  }
  return {
    status: "ok",
    value: input as Input,
  };
}

export function execute(
  request: ToolRequest,
  context: {
    scriptRunner: ScriptRunner | undefined;
    threadId: ThreadId;
  },
): ExecutingToolInvocation {
  const promise = (async (): Promise<ExecutedToolResult> => {
    await Promise.resolve();
    const { scriptRunner } = context;
    if (!scriptRunner) {
      return errorResult(request.id, "scripts are not available");
    }
    const entry = scriptRunner
      .getScriptCatalog()
      .find((c) => c.name === request.input.scriptName);
    if (!entry) {
      return errorResult(
        request.id,
        `unknown script: ${request.input.scriptName}`,
      );
    }

    // Step 1: no parameters supplied yet — return the script's parameter schema
    // so the agent can construct a valid call without us bloating the tool spec
    // with every script's schema up front.
    if (request.input.parameters === undefined) {
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: [
            {
              type: "text",
              text: `Parameter schema for "${entry.name}". Call run_script again with this scriptName and a matching \`parameters\` object to run it.\n\n${JSON.stringify(entry.parameterSchema, null, 2)}`,
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            },
          ],
          structuredResult: { toolName: "run_script" as const },
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      };
    }

    const schemaErrors = validateAgainstSchema(
      request.input.parameters,
      entry.parameterSchema,
    );
    if (schemaErrors.length > 0) {
      return errorResult(
        request.id,
        `parameters do not match the schema for "${entry.name}":\n- ${schemaErrors.join(
          "\n- ",
        )}\n\nExpected schema:\n${JSON.stringify(entry.parameterSchema, null, 2)}`,
      );
    }

    try {
      scriptRunner.runScript({
        scriptName: request.input.scriptName,
        parameters: request.input.parameters,
        triggeringThreadId: context.threadId,
      });
    } catch (error) {
      return errorResult(
        request.id,
        `failed to start script: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      type: "tool_result",
      id: request.id,
      result: {
        status: "ok",
        value: [
          {
            type: "text",
            text: `Started script "${request.input.scriptName}". It runs independently; check the Scripts section for progress.`,
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          },
        ],
        structuredResult: { toolName: "run_script" as const },
      },
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    };
  })();

  return {
    promise,
    abort: () => {},
  };
}

function errorResult(id: ToolRequest["id"], error: string): ExecutedToolResult {
  return {
    type: "tool_result",
    id,
    result: { status: "error", error },
    nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
  };
}
