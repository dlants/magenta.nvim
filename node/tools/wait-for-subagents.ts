import { type Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";

import type { ToolName, GenericToolRequest, ToolInvocation } from "./types.ts";

import type { ThreadId } from "../chat/types";
import { assertUnreachable } from "../utils/assertUnreachable.ts";

import type { ThreadManager } from "../capabilities/thread-manager.ts";

export type Input = {
  threadIds: ThreadId[];
};

export type ToolRequest = GenericToolRequest<"wait_for_subagents", Input>;

export type WaitForSubagentsProgress = {
  completedThreadIds: ThreadId[];
};

export function execute(
  request: ToolRequest,
  context: {
    threadManager: ThreadManager;
    requestRender: () => void;
  },
): ToolInvocation & { progress: WaitForSubagentsProgress } {
  const progress: WaitForSubagentsProgress = {
    completedThreadIds: [],
  };

  const promise = (async (): Promise<ProviderToolResult> => {
    try {
      const threadIds = request.input.threadIds;
      const results = await Promise.all(
        threadIds.map(async (threadId: ThreadId) => {
          const result = await context.threadManager.waitForThread(threadId);
          progress.completedThreadIds.push(threadId);
          context.requestRender();
          return { threadId, result };
        }),
      );

      const text = `\
All subagents completed:
${results
  .map(({ threadId, result }) => {
    switch (result.status) {
      case "ok":
        return `- Thread ${threadId}: ${result.value}`;
      case "error":
        return `- Thread ${threadId}: ❌ Error: ${result.error}`;
      default:
        return assertUnreachable(result);
    }
  })
  .join("\n")}`;

      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "ok",
          value: [{ type: "text", text }],
        },
      };
    } catch (e) {
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }
  })();

  return { promise, abort: () => {}, progress };
}

export const spec: ProviderToolSpec = {
  name: "wait_for_subagents" as ToolName,
  description: `Wait for one or more subagents to complete execution. This tool blocks until all specified subagents have finished running and returned their results.`,
  input_schema: {
    type: "object",
    properties: {
      threadIds: {
        type: "array",
        items: {
          type: "string",
        },
        description: "Array of thread IDs to wait for completion",
        minItems: 1,
      },
    },
    required: ["threadIds"],
  },
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (!Array.isArray(input.threadIds)) {
    return {
      status: "error",
      error: `expected req.input.threadIds to be an array but it was ${JSON.stringify(input.threadIds)}`,
    };
  }

  if (input.threadIds.length === 0) {
    return {
      status: "error",
      error: "threadIds array cannot be empty",
    };
  }

  if (!input.threadIds.every((item) => typeof item === "string")) {
    return {
      status: "error",
      error: `expected all items in req.input.threadIds to be strings but they were ${JSON.stringify(input.threadIds)}`,
    };
  }

  return {
    status: "ok",
    value: {
      threadIds: input.threadIds as ThreadId[],
    },
  };
}
