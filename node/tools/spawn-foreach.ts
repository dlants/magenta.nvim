import { type Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";

import type { GenericToolRequest, ToolName, ToolInvocation } from "./types.ts";
import type { ThreadManager } from "./thread-manager.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";

import { AGENT_TYPES, type AgentType } from "../providers/system-prompt.ts";
import type { ThreadId, ThreadType } from "../chat/types.ts";

export type ForEachElement = string & { __forEachElement: true };

export type SpawnForeachElementProgress =
  | { status: "pending" }
  | { status: "running"; threadId: ThreadId }
  | { status: "completed"; threadId?: ThreadId; result: Result<string> };

export type SpawnForeachProgress = {
  elements: Array<{
    element: ForEachElement;
    state: SpawnForeachElementProgress;
  }>;
};

export function execute(
  request: ToolRequest,
  context: {
    threadManager: ThreadManager;
    threadId: ThreadId;
    maxConcurrentSubagents: number;
    requestRender: () => void;
  },
): ToolInvocation & { progress: SpawnForeachProgress } {
  const validationResult = validateInput(
    request.input as Record<string, unknown>,
  );

  if (validationResult.status === "error") {
    const errorResult: ProviderToolResult = {
      type: "tool_result",
      id: request.id,
      result: { status: "error", error: validationResult.error },
    };
    return {
      promise: Promise.resolve(errorResult),
      abort: () => {},
      progress: { elements: [] },
    };
  }

  const input = validationResult.value;
  const progress: SpawnForeachProgress = {
    elements: input.elements.map((element) => ({
      element,
      state: { status: "pending" as const },
    })),
  };

  const abortController = { aborted: false };

  const processElement = async (
    entry: SpawnForeachProgress["elements"][0],
    threadType: ThreadType,
    contextFiles: UnresolvedFilePath[],
  ): Promise<void> => {
    if (abortController.aborted) return;

    const enhancedPrompt = `${input.prompt}\n\nYou are one of several agents working in parallel on this prompt. Your task is to complete this prompt for this specific case:\n\n${entry.element}`;

    try {
      entry.state = { status: "running", threadId: "" as ThreadId };
      context.requestRender();

      const threadId = await context.threadManager.spawnThread({
        parentThreadId: context.threadId,
        prompt: enhancedPrompt,
        threadType,
        ...(contextFiles.length > 0 ? { contextFiles } : {}),
      });

      entry.state = { status: "running", threadId };
      context.requestRender();

      const result = await context.threadManager.waitForThread(threadId);

      entry.state = { status: "completed", threadId, result };
      context.requestRender();
    } catch (e) {
      entry.state = {
        status: "completed",
        result: {
          status: "error",
          error: e instanceof Error ? e.message : String(e),
        },
      };
      context.requestRender();
    }
  };

  const promise = (async (): Promise<ProviderToolResult> => {
    try {
      const threadType: ThreadType =
        input.agentType === "fast" ? "subagent_fast" : "subagent_default";
      const contextFiles = input.contextFiles || [];
      const maxConcurrent = context.maxConcurrentSubagents;

      // Slot-based concurrency: start next element as soon as any slot opens
      let nextIdx = 0;
      const inFlight = new Set<Promise<void>>();

      const startNext = (): void => {
        if (nextIdx >= progress.elements.length || abortController.aborted)
          return;
        const entry = progress.elements[nextIdx++];
        const p = processElement(entry, threadType, contextFiles).then(() => {
          inFlight.delete(p);
        });
        inFlight.add(p);
      };

      // Fill initial slots
      while (
        nextIdx < progress.elements.length &&
        inFlight.size < maxConcurrent
      ) {
        startNext();
      }

      // As each completes, start the next
      while (inFlight.size > 0) {
        await Promise.race(inFlight);
        if (!abortController.aborted) {
          startNext();
        }
      }

      if (abortController.aborted) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Foreach sub-agent execution was aborted",
          },
        };
      }

      return buildForeachResult(request.id, progress);
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

  return {
    promise,
    abort: () => {
      abortController.aborted = true;
    },
    progress,
  };
}

function buildForeachResult(
  requestId: ToolRequest["id"],
  progress: SpawnForeachProgress,
): ProviderToolResult {
  const completedElements = progress.elements.filter(
    (el) => el.state.status === "completed",
  );
  const successful = completedElements.filter(
    (el) => el.state.status === "completed" && el.state.result.status === "ok",
  );
  const failed = completedElements.filter(
    (el) =>
      el.state.status === "completed" && el.state.result.status === "error",
  );

  let resultText = `Foreach subagent execution completed:\n\n`;
  resultText += `Total elements: ${progress.elements.length}\n`;
  resultText += `Successful: ${successful.length}\n`;
  resultText += `Failed: ${failed.length}\n\n`;

  resultText += `ElementThreads:\n`;
  for (const item of completedElements) {
    if (item.state.status === "completed" && item.state.threadId) {
      const status = item.state.result.status === "ok" ? "ok" : "error";
      resultText += `${item.element}::${item.state.threadId}::${status}\n`;
    }
  }
  resultText += `\n`;

  if (successful.length > 0) {
    resultText += `Successful results:\n`;
    for (const item of successful) {
      const result =
        item.state.status === "completed" && item.state.result.status === "ok"
          ? item.state.result.value
          : "";
      resultText += `- ${item.element}: ${result}\n`;
    }
    resultText += `\n`;
  }

  if (failed.length > 0) {
    resultText += `Failed results:\n`;
    for (const item of failed) {
      const error =
        item.state.status === "completed" &&
        item.state.result.status === "error"
          ? item.state.result.error
          : "";
      resultText += `- ${item.element}: ${error}\n`;
    }
  }

  return {
    type: "tool_result",
    id: requestId,
    result: {
      status: "ok",
      value: [{ type: "text", text: resultText }],
    },
  };
}

export const spec: ProviderToolSpec = {
  name: "spawn_foreach" as ToolName,
  description: `Create multiple sub-agents that run in parallel to process an array of elements.

## Effective Usage
**Provide clear prompts:**
- Write the prompt as if working on a single element
- The specific element will be appended to your prompt automatically
- Include context about what the element represents

**Examples:**

<example>
user: I have these quickfix locations that need to be fixed: [file1.ts:10, file2.ts:25, file3.ts:40]
assistant: [spawns foreach subagents with ["file1.ts:10", "file2.ts:25", "file3.ts:40"] to fix each location in parallel]
</example>

<example>
user: refactor this interface
assistant: [uses find_references tool to get all reference locations: file1.ts:15, file2.ts:10, file2.ts:25, file2.ts:40]
assistant: [spawns foreach subagents with fast agent type and elements ["file1.ts:15", "file2.ts:10,25,40"]]
</example>`,
  input_schema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The base prompt that will be sent to each sub-agent.",
      },
      elements: {
        type: "array",
        items: {
          type: "string",
        },
        description: `Array of elements to process in parallel.
Each element will be appended to the prompt for its corresponding sub-agent.`,
      },
      contextFiles: {
        type: "array",
        items: {
          type: "string",
        },
        description: `Optional list of file paths to provide as context to all sub-agents.`,
      },
      agentType: {
        type: "string",
        enum: AGENT_TYPES as unknown as string[],
        description: `Optional agent type to use for sub-agents.
'fast' for quick and simple transformations that don't require a very intelligent model
'default' for everything else`,
      },
    },
    required: ["prompt", "elements"],
  },
};

export type Input = {
  prompt: string;
  elements: ForEachElement[];
  contextFiles?: UnresolvedFilePath[] | undefined;
  agentType?: AgentType | undefined;
};

export type ToolRequest = GenericToolRequest<"spawn_foreach", Input>;

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.prompt !== "string") {
    return {
      status: "error",
      error: `expected req.input.prompt to be a string but it was ${JSON.stringify(input.prompt)}`,
    };
  }

  if (!Array.isArray(input.elements)) {
    return {
      status: "error",
      error: `expected req.input.elements to be an array but it was ${JSON.stringify(input.elements)}`,
    };
  }

  if (input.elements.length === 0) {
    return {
      status: "error",
      error: "elements array cannot be empty",
    };
  }

  if (!input.elements.every((item) => typeof item === "string")) {
    return {
      status: "error",
      error: `expected all items in req.input.elements to be strings but they were ${JSON.stringify(input.elements)}`,
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

  const validatedInput: Input = {
    prompt: input.prompt,
    elements: input.elements.map((element) => element as ForEachElement),
    contextFiles: input.contextFiles as UnresolvedFilePath[] | undefined,
    agentType: input.agentType as AgentType | undefined,
  };

  return {
    status: "ok",
    value: validatedInput,
  };
}
