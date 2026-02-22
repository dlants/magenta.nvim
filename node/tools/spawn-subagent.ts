import { type Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { ToolName, GenericToolRequest, ToolInvocation } from "./types.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { ThreadManager } from "./thread-manager.ts";

import { AGENT_TYPES, type AgentType } from "../providers/system-prompt.ts";
import type { ThreadId, ThreadType } from "../chat/types.ts";

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const SPAWN_SUBAGENT_DESCRIPTION = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "spawn-subagent-description.md",
  ),
  "utf-8",
);

export type ToolRequest = GenericToolRequest<"spawn_subagent", Input>;

export type SpawnSubagentProgress = {
  threadId?: ThreadId;
};

export function execute(
  request: ToolRequest,
  context: {
    threadManager: ThreadManager;
    threadId: ThreadId;
    requestRender: () => void;
  },
): ToolInvocation & { progress: SpawnSubagentProgress } {
  const progress: SpawnSubagentProgress = {};

  const promise = (async (): Promise<ProviderToolResult> => {
    try {
      const input = request.input;
      const threadType: ThreadType =
        input.agentType === "fast"
          ? "subagent_fast"
          : input.agentType === "explore"
            ? "subagent_explore"
            : "subagent_default";

      const threadId = await context.threadManager.spawnThread({
        parentThreadId: context.threadId,
        prompt: input.prompt,
        threadType,
        ...(input.contextFiles ? { contextFiles: input.contextFiles } : {}),
      });

      progress.threadId = threadId;
      context.requestRender();

      if (!input.blocking) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `Sub-agent started with threadId: ${threadId}`,
              },
            ],
          },
        };
      }

      const result = await context.threadManager.waitForThread(threadId);

      return {
        type: "tool_result",
        id: request.id,
        result:
          result.status === "ok"
            ? {
                status: "ok",
                value: [
                  {
                    type: "text",
                    text: `Sub-agent (${threadId}) completed:\n${result.value}`,
                  },
                ],
              }
            : {
                status: "error",
                error: `Sub-agent (${threadId}) failed: ${result.error}`,
              },
      };
    } catch (e) {
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: `Failed to create sub-agent thread: ${e instanceof Error ? e.message : String(e)}`,
        },
      };
    }
  })();

  return { promise, abort: () => {}, progress };
}

export const spec: ProviderToolSpec = {
  name: "spawn_subagent" as ToolName,
  description: SPAWN_SUBAGENT_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "The sub-agent prompt. This should contain a clear question, and information about what the answer should look like.",
      },
      contextFiles: {
        type: "array",
        items: {
          type: "string",
        },
        description:
          "Optional list of file paths to provide as context to the sub-agent.",
      },
      agentType: {
        type: "string",
        enum: AGENT_TYPES as unknown as string[],
        description:
          "Optional agent type to use for the sub-agent. Use 'explore' for answering specific questions about the codebase (returns file paths and descriptions, not code). Use 'fast' for simple editing tasks. Use 'default' for tasks that require more thought and smarts.",
      },
      blocking: {
        type: "boolean",
        description:
          "Pause this thread until the subagent finishes. If false (default), the tool returns immediately with the threadId you can use with wait_for_subagents to get the result.",
      },
    },

    required: ["prompt"],
  },
};

export type Input = {
  prompt: string;
  contextFiles?: UnresolvedFilePath[];
  agentType?: AgentType;
  blocking?: boolean;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.prompt != "string") {
    return {
      status: "error",
      error: `expected req.input.prompt to be a string but it was ${JSON.stringify(input.prompt)}`,
    };
  }

  if (input.contextFiles !== undefined) {
    if (!Array.isArray(input.contextFiles)) {
      return {
        status: "error",
        error: `expected req.input.contextFiles to be an array but it was ${JSON.stringify(input.contextFiles)}`,
      };
    }

    if (!input.contextFiles.every((item) => typeof item === "string")) {
      return {
        status: "error",
        error: `expected all items in req.input.contextFiles to be strings but they were ${JSON.stringify(input.contextFiles)}`,
      };
    }
  }

  if (input.agentType !== undefined) {
    if (typeof input.agentType !== "string") {
      return {
        status: "error",
        error: `expected req.input.agentType to be a string but it was ${JSON.stringify(input.agentType)}`,
      };
    }

    if (!AGENT_TYPES.includes(input.agentType as AgentType)) {
      return {
        status: "error",
        error: `expected req.input.agentType to be one of ${AGENT_TYPES.join(", ")} but it was ${JSON.stringify(input.agentType)}`,
      };
    }
  }

  if (input.blocking !== undefined) {
    if (typeof input.blocking !== "boolean") {
      return {
        status: "error",
        error: `expected req.input.blocking to be a boolean but it was ${JSON.stringify(input.blocking)}`,
      };
    }
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
