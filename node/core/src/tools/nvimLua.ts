import type { LuaExecutor } from "../capabilities/lua-executor.ts";
import {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderToolResult,
  type ProviderToolSpec,
} from "../providers/provider-types.ts";
import type { ToolInvocation, ToolName, ToolRequestId } from "../tool-types.ts";
import type { Result } from "../utils/result.ts";

export type ToolRequest = {
  id: ToolRequestId;
  toolName: "nvim_lua";
  input: Input;
};
export type StructuredResult = { toolName: "nvim_lua" };

function formatResult(value: unknown): string {
  if (value === undefined || value === null) {
    return "Executed successfully, no return value.";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function execute(
  request: ToolRequest,
  context: {
    luaExecutor: LuaExecutor;
  },
): ToolInvocation {
  let aborted = false;

  const promise = (async (): Promise<ProviderToolResult> => {
    try {
      const value = await context.luaExecutor.execLua(request.input.code);

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
          value: [
            {
              type: "text",
              text: formatResult(value),
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            },
          ],
          structuredResult: { toolName: "nvim_lua" as ToolName },
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
          error: `Error executing Lua: ${error instanceof Error ? error.message : String(error)}`,
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
  name: "nvim_lua" as ToolName,
  description: `Execute a chunk of Lua code in the host neovim instance and get the result back.
The code is run via nvim_exec_lua. Whatever the chunk \`return\`s is sent back to you (JSON-formatted when possible).
Use this to inspect or manipulate the live editor state, or examine neovim/plugin docs (e.g. vim.fn.getcompletion(query, "help") or vim.api.nvim_get_runtime_file).`,
  input_schema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "The Lua source to evaluate in neovim. Use a `return` statement to send a value back.",
      },
    },
    required: ["code"],
  },
};

export type Input = {
  code: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.code !== "string") {
    return { status: "error", error: "expected input.code to be a string" };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
