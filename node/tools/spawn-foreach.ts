import { d, withBindings } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { StaticTool, ToolName } from "./types.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import { AGENT_TYPES, type AgentType } from "../providers/system-prompt.ts";
import type { ThreadId, ThreadType } from "../chat/types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Chat } from "../chat/chat.ts";

export type ForEachElement = string & { __forEachElement: true };

export type Msg =
  | {
      type: "foreach-subagent-created";
      result: Result<ThreadId>;
      element: ForEachElement;
    }
  | {
      type: "subagent-completed";
      threadId: ThreadId;
      result: Result<string>;
    };

type ElementState =
  | {
      status: "pending";
    }
  | {
      status: "spawning";
    }
  | {
      status: "running";
      threadId: ThreadId;
    }
  | {
      status: "completed";
      threadId?: ThreadId;
      result: Result<string>;
    };

export type State =
  | {
      state: "running";
      elements: Array<{
        element: ForEachElement;
        state: ElementState;
      }>;
    }
  | {
      state: "done";
      result: ProviderToolResult;
    };

export class SpawnForeachTool implements StaticTool {
  toolName = "spawn_foreach" as const;
  public state: State;

  constructor(
    public request: Extract<StaticToolRequest, { toolName: "spawn_foreach" }>,
    public context: {
      nvim: Nvim;
      dispatch: Dispatch<RootMsg>;
      chat: Chat;
      threadId: ThreadId;
      myDispatch: Dispatch<Msg>;
      maxConcurrentSubagents: number;
    },
  ) {
    // Validate the input first
    const validationResult = validateInput(
      this.request.input as Record<string, unknown>,
    );
    if (validationResult.status === "error") {
      // If validation fails, initialize with error state
      this.state = {
        state: "done",
        result: {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "error",
            error: validationResult.error,
          },
        },
      };
      return;
    }

    const input = validationResult.value;
    this.state = {
      state: "running",
      elements: input.elements.map((element) => ({
        element,
        state: { status: "pending" },
      })),
    };

    // Start the process of spawning foreach subagents
    setTimeout(() => {
      this.startNextBatch();
    });
  }

  private startNextBatch(): void {
    if (this.state.state !== "running") {
      return;
    }

    const maxConcurrent = this.context.maxConcurrentSubagents;
    const currentRunning = this.state.elements.filter(
      (el) => el.state.status === "running" || el.state.status === "spawning",
    ).length;
    const pendingElements = this.state.elements.filter(
      (el) => el.state.status === "pending",
    );

    const slotsAvailable = maxConcurrent - currentRunning;

    if (slotsAvailable <= 0 || pendingElements.length === 0) {
      return;
    }

    // Start as many subagents as we have slots and pending elements
    const elementsToStart = pendingElements.slice(0, slotsAvailable);

    for (const elementWrapper of elementsToStart) {
      // Mark element as spawning
      elementWrapper.state = { status: "spawning" };
      this.spawnSubagentForElement(elementWrapper.element);
    }
  }

  private spawnSubagentForElement(element: ForEachElement): void {
    if (this.state.state !== "running") {
      return;
    }

    // Re-validate input to get proper typing
    const validationResult = validateInput(
      this.request.input as Record<string, unknown>,
    );
    if (validationResult.status === "error") {
      this.context.nvim.logger?.error(
        `Input validation failed: ${validationResult.error}`,
      );
      return;
    }

    const input = validationResult.value;
    const enhancedPrompt = `${input.prompt}

You are one of several agents working in parallel on this prompt. Your task is to complete this prompt for this specific case:

${element}`;

    const contextFiles = input.contextFiles || [];
    const threadType: ThreadType = input.agentType
      ? input.agentType == "learn"
        ? "subagent_learn"
        : input.agentType == "plan"
          ? "subagent_plan"
          : input.agentType == "fast"
            ? "subagent_fast"
            : "subagent_default"
      : "subagent_default";

    this.context.dispatch({
      type: "chat-msg",
      msg: {
        type: "spawn-subagent-thread",
        parentThreadId: this.context.threadId,
        spawnToolRequestId: this.request.id,
        inputMessages: [{ type: "system", text: enhancedPrompt }],
        threadType,
        contextFiles,
        foreachElement: element,
      },
    });
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  abort() {
    this.state = {
      state: "done",
      result: {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "error",
          error: "Foreach sub-agent execution was aborted",
        },
      },
    };
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "foreach-subagent-created":
        this.handleForeachSubagentCreated(msg);
        return;

      case "subagent-completed":
        this.handleSubagentCompleted(msg);
        return;

      default:
        assertUnreachable(msg);
    }
  }

  private handleForeachSubagentCreated(msg: {
    result: Result<ThreadId>;
    element: ForEachElement;
  }): void {
    if (this.state.state !== "running") {
      return;
    }

    const elementWrapper = this.state.elements.find(
      (el) => el.element === msg.element,
    );

    if (!elementWrapper) {
      this.context.nvim.logger?.error(
        `Received subagent-created for unknown element: ${msg.element}`,
      );
      return;
    }

    switch (msg.result.status) {
      case "ok":
        elementWrapper.state = {
          status: "running",
          threadId: msg.result.value,
        };
        break;

      case "error":
        elementWrapper.state = {
          status: "completed",
          result: {
            status: "error",
            error: `Failed to create sub-agent thread: ${msg.result.error}`,
          },
        };
        // Try to start next batch
        setTimeout(() => this.startNextBatch());
        break;
    }
  }

  private handleSubagentCompleted(msg: {
    threadId: ThreadId;
    result: Result<string>;
  }): void {
    if (this.state.state !== "running") {
      return;
    }

    // Find the element and update its state
    const elementWrapper = this.state.elements.find(
      (el) =>
        el.state.status == "running" && el.state.threadId === msg.threadId,
    );
    if (elementWrapper) {
      elementWrapper.state = {
        status: "completed",
        threadId: msg.threadId,
        result: msg.result,
      };
    }

    // Check if all subagents are done
    const allCompleted = this.state.elements.every(
      (el) => el.state.status === "completed",
    );
    const anyPending = this.state.elements.some(
      (el) => el.state.status === "pending",
    );

    if (allCompleted) {
      // All done, transition to done state
      this.state = {
        state: "done",
        result: this.buildResult(),
      };
    } else if (anyPending) {
      // Start next batch if there are pending elements
      setTimeout(() => this.startNextBatch());
    }
  }

  private buildResult(): ProviderToolResult {
    if (this.state.state !== "running") {
      throw new Error("buildResult called when not in running state");
    }

    const completedElements = this.state.elements.filter(
      (el) => el.state.status === "completed",
    );
    const successful = completedElements.filter(
      (el) =>
        el.state.status === "completed" && el.state.result.status === "ok",
    );
    const failed = completedElements.filter(
      (el) =>
        el.state.status === "completed" && el.state.result.status === "error",
    );

    let resultText = `Foreach subagent execution completed:\n\n`;
    resultText += `Total elements: ${this.state.elements.length}\n`;
    resultText += `Successful: ${successful.length}\n`;
    resultText += `Failed: ${failed.length}\n\n`;

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
      id: this.request.id,
      result: {
        status: "ok",
        value: [
          {
            type: "text",
            text: resultText,
          },
        ],
      },
    };
  }

  getToolResult(): ProviderToolResult {
    if (this.state.state !== "done") {
      const completed = this.state.elements.filter(
        (el) => el.state.status === "completed",
      ).length;
      const total = this.state.elements.length;
      const running = this.state.elements.filter(
        (el) => el.state.status === "running" || el.state.status === "spawning",
      ).length;

      return {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "ok",
          value: [
            {
              type: "text",
              text: `Foreach subagents progress: ${completed}/${total} completed, ${running} running...`,
            },
          ],
        },
      };
    }

    return this.state.result;
  }

  private renderElementWithThread(element: ForEachElement, threadId: ThreadId) {
    const summary = this.context.chat.getThreadSummary(threadId);

    let statusText: string;
    switch (summary.status.type) {
      case "missing":
        statusText = `  - ${element}: ❓ not found`;
        break;

      case "pending":
        statusText = `  - ${element}: ⏳ initializing`;
        break;

      case "running":
        statusText = `  - ${element}: ⏳ ${summary.status.activity}`;
        break;

      case "stopped":
        statusText = `  - ${element}: ⏹️ stopped (${summary.status.reason})`;
        break;

      case "yielded": {
        const truncatedResponse =
          summary.status.response.length > 50
            ? summary.status.response.substring(0, 47) + "..."
            : summary.status.response;
        statusText = `  - ${element}: ✅ yielded: ${truncatedResponse}`;
        break;
      }

      case "error": {
        const truncatedError =
          summary.status.message.length > 50
            ? summary.status.message.substring(0, 47) + "..."
            : summary.status.message;
        statusText = `  - ${element}: ❌ error: ${truncatedError}`;
        break;
      }

      default:
        return assertUnreachable(summary.status);
    }

    return withBindings(d`${statusText}\n`, {
      "<CR>": () => {
        this.context.dispatch({
          type: "chat-msg",
          msg: {
            type: "select-thread",
            id: threadId,
          },
        });
      },
    });
  }

  renderSummary() {
    // Re-validate input to get proper typing
    const validationResult = validateInput(
      this.request.input as Record<string, unknown>,
    );
    const agentTypeText =
      validationResult.status === "ok" && validationResult.value.agentType
        ? ` (${validationResult.value.agentType})`
        : "";

    switch (this.state.state) {
      case "running": {
        const completed = this.state.elements.filter(
          (el) => el.state.status === "completed",
        ).length;
        const total = this.state.elements.length;

        const elementViews = this.state.elements.map((elementWrapper) => {
          const element = elementWrapper.element;
          const state = elementWrapper.state;

          switch (state.status) {
            case "completed": {
              const status = state.result.status === "ok" ? "✅" : "❌";
              if (state.threadId) {
                return this.renderElementWithThread(element, state.threadId);
              } else {
                return d`  - ${element}: ${status}\n`;
              }
            }
            case "running": {
              return this.renderElementWithThread(element, state.threadId);
            }
            case "spawning": {
              return d`  - ${element}: 🚀\n`;
            }
            case "pending": {
              return d`  - ${element}: ⏸️\n`;
            }
            default:
              return assertUnreachable(state);
          }
        });

        return d`🤖⏳ Foreach subagents${agentTypeText} (${completed.toString()}/${total.toString()}):
${elementViews}`;
      }

      case "done": {
        const result = this.state.result.result;

        // Re-validate input to get element count for display
        const validationResult = validateInput(
          this.request.input as Record<string, unknown>,
        );
        const totalElements =
          validationResult.status === "ok"
            ? validationResult.value.elements.length
            : 0;

        if (result.status === "error") {
          return d`🤖❌ Foreach subagents${agentTypeText} (${totalElements.toString()}/${totalElements.toString()})`;
        } else {
          return d`🤖✅ Foreach subagents${agentTypeText} (${totalElements.toString()}/${totalElements.toString()})`;
        }
      }
    }
  }
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
'learn' for learning and discovery tasks
'plan' for planning and strategy tasks
'fast' for quick and simple transformations that don't require a very intelligent model`,
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
