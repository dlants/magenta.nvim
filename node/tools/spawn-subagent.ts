import { d, withBindings, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { CompletedToolInfo } from "./types.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { StaticTool, ToolName, GenericToolRequest } from "./types.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import { AGENT_TYPES, type AgentType } from "../providers/system-prompt.ts";
import type { ThreadId, ThreadType } from "../chat/types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Chat } from "../chat/chat.ts";
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

export type Msg =
  | {
      type: "subagent-created";
      result: Result<ThreadId>;
    }
  | {
      type: "check-thread";
    };

export type State =
  | {
      state: "preparing";
    }
  | {
      state: "waiting-for-subagent";
      threadId: ThreadId;
    }
  | {
      state: "done";
      result: ProviderToolResult;
    };

function truncate(text: string, maxLen: number = 50): string {
  const singleLine = text.replace(/\n/g, " ");
  return singleLine.length > maxLen
    ? singleLine.substring(0, maxLen) + "..."
    : singleLine;
}

function agentTypeLabel(agentType: AgentType | undefined): string {
  return agentType && agentType !== "default" ? ` (${agentType})` : "";
}
export class SpawnSubagentTool implements StaticTool {
  toolName = "spawn_subagent" as const;
  public state: State;
  public aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public context: {
      nvim: Nvim;
      dispatch: Dispatch<RootMsg>;
      chat: Chat;
      threadId: ThreadId;
      myDispatch: Dispatch<Msg>;
    },
  ) {
    this.state = {
      state: "preparing",
    };

    // Start the process of spawning a sub-agent
    // Wrap in setTimeout to force new eventloop frame, to avoid dispatch-in-dispatch
    setTimeout(() => {
      if (this.aborted) return;
      this.spawnSubagent();
    });
  }

  private spawnSubagent(): void {
    const input = this.request.input;
    const prompt = input.prompt;
    const contextFiles = input.contextFiles || [];
    const threadType: ThreadType =
      input.agentType === "fast"
        ? "subagent_fast"
        : input.agentType === "explore"
          ? "subagent_explore"
          : "subagent_default";

    this.context.dispatch({
      type: "chat-msg",
      msg: {
        type: "spawn-subagent-thread",
        parentThreadId: this.context.threadId,
        spawnToolRequestId: this.request.id,
        inputMessages: [{ type: "system", text: prompt }],
        threadType,
        contextFiles,
      },
    });
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  isPendingUserAction(): boolean {
    return false; // Spawn subagent never requires user action
  }

  abort(): ProviderToolResult {
    if (this.state.state === "done") {
      return this.getToolResult();
    }

    this.aborted = true;

    const result: ProviderToolResult = {
      type: "tool_result",
      id: this.request.id,
      result: {
        status: "error",
        error: "Request was aborted by the user.",
      },
    };

    this.state = {
      state: "done",
      result,
    };

    return result;
  }

  update(msg: Msg): void {
    if (this.aborted) return;

    switch (msg.type) {
      case "subagent-created":
        switch (msg.result.status) {
          case "ok": {
            const threadId = msg.result.value;
            const isBlocking = this.request.input.blocking === true;

            if (isBlocking) {
              this.state = {
                state: "waiting-for-subagent",
                threadId,
              };
              this.checkThread();
            } else {
              this.state = {
                state: "done",
                result: {
                  type: "tool_result",
                  id: this.request.id,
                  result: {
                    status: "ok",
                    value: [
                      {
                        type: "text",
                        text: `Sub-agent started with threadId: ${threadId}`,
                      },
                    ],
                  },
                },
              };
            }
            break;
          }

          case "error":
            this.state = {
              state: "done",
              result: {
                type: "tool_result",
                id: this.request.id,
                result: {
                  status: "error",
                  error: `Failed to create sub-agent thread: ${msg.result.error}`,
                },
              },
            };
            return;
        }
        return;

      case "check-thread":
        this.checkThread();
        return;

      default:
        assertUnreachable(msg);
    }
  }

  private checkThread(): void {
    if (this.state.state !== "waiting-for-subagent" || this.aborted) {
      return;
    }

    const threadId = this.state.threadId;
    const threadResult = this.context.chat.getThreadResult(threadId);

    switch (threadResult.status) {
      case "done": {
        const result = threadResult.result;
        this.state = {
          state: "done",
          result: {
            type: "tool_result",
            id: this.request.id,
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
          },
        };
        break;
      }

      case "pending":
        // Still waiting, will be checked again when thread state changes
        return;

      default:
        assertUnreachable(threadResult);
    }
  }

  getToolResult(): ProviderToolResult {
    if (this.state.state !== "done") {
      return {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "ok",
          value: [
            { type: "text", text: `Waiting for subagent to finish running...` },
          ],
        },
      };
    }

    return this.state.result;
  }

  renderSummary(): VDOMNode {
    const input = this.request.input;
    const typeLabel = agentTypeLabel(input.agentType);

    switch (this.state.state) {
      case "preparing":
        return d`🚀⚙️ spawn_subagent${typeLabel}: ${truncate(input.prompt)}`;
      case "waiting-for-subagent": {
        const summary = this.context.chat.getThreadSummary(this.state.threadId);
        const displayName = this.context.chat.getThreadDisplayName(
          this.state.threadId,
        );
        let statusText: string;

        switch (summary.status.type) {
          case "missing":
            statusText = "❓ not found";
            break;
          case "pending":
            statusText = "⏳ initializing";
            break;
          case "running":
            statusText = `⏳ ${summary.status.activity}`;
            break;
          case "stopped":
            statusText = `⏹️ stopped (${summary.status.reason})`;
            break;
          case "yielded":
            statusText = "✅ yielded";
            break;
          case "error":
            statusText = `❌ error`;
            break;
          default:
            assertUnreachable(summary.status);
        }

        return withBindings(
          d`🚀⏳ spawn_subagent${typeLabel} (blocking) ${displayName}: ${statusText}`,
          {
            "<CR>": () =>
              this.context.dispatch({
                type: "chat-msg",
                msg: {
                  type: "select-thread",
                  id:
                    this.state.state === "waiting-for-subagent"
                      ? this.state.threadId
                      : (undefined as unknown as ThreadId),
                },
              }),
          },
        );
      }
      case "done":
        return renderCompletedSummary(
          {
            request: this.request as CompletedToolInfo["request"],
            result: this.state.result,
          },
          this.context.dispatch,
          this.context.chat,
        );
    }
  }
}

export function renderCompletedSummary(
  info: CompletedToolInfo,
  dispatch: Dispatch<RootMsg>,
  chat?: Chat,
): VDOMNode {
  const input = info.request.input as Input;
  const typeLabel = agentTypeLabel(input.agentType);
  const result = info.result.result;
  if (result.status === "error") {
    const errorPreview =
      result.error.length > 50
        ? result.error.substring(0, 50) + "..."
        : result.error;

    return d`🤖❌ spawn_subagent${typeLabel}: ${errorPreview}`;
  }

  // Parse threadId from result text
  const resultText =
    result.value[0]?.type === "text" ? result.value[0].text : "";
  const match = resultText.match(/threadId: ([a-f0-9-]+)/);
  const threadId = match ? (match[1] as ThreadId) : undefined;

  // Check if this was a blocking call by looking for "completed:" in the result
  const isBlocking = resultText.includes("completed:");

  // For blocking calls, also try to extract threadId from the "Sub-agent (threadId) completed:" format
  const blockingMatch = resultText.match(/Sub-agent \(([a-f0-9-]+)\)/);
  const effectiveThreadId =
    threadId || (blockingMatch ? (blockingMatch[1] as ThreadId) : undefined);

  return withBindings(
    d`🤖✅ spawn_subagent${typeLabel}${isBlocking ? " (blocking)" : ""}: ${effectiveThreadId && chat ? truncate(chat.getThreadDisplayName(effectiveThreadId)) : truncate(input.prompt)}`,
    {
      "<CR>": () => {
        if (effectiveThreadId) {
          dispatch({
            type: "chat-msg",
            msg: {
              type: "select-thread",
              id: effectiveThreadId,
            },
          });
        }
      },
    },
  );
}

export function renderCompletedPreview(info: CompletedToolInfo): VDOMNode {
  const result = info.result.result;
  if (result.status === "error") {
    return d``;
  }

  const resultText =
    result.value[0]?.type === "text" ? result.value[0].text : "";

  const completedMatch = resultText.match(/completed:\n([\s\S]*)/);
  if (completedMatch) {
    const response = completedMatch[1];
    const lineCount = response.split("\n").length;
    return d`${lineCount.toString()} lines`;
  }

  return d``;
}

export function renderCompletedDetail(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;

  const promptSection = d`**Prompt:**\n${input.prompt}`;

  if (result.status === "error") {
    return d`${promptSection}\n\n**Error:**\n${result.error}`;
  }

  const resultText =
    result.value[0]?.type === "text" ? result.value[0].text : "";

  // Check if this was a blocking call
  const completedMatch = resultText.match(/completed:\n([\s\S]*)/);
  if (completedMatch) {
    const response = completedMatch[1];
    return d`${promptSection}\n\n**Response:**\n${response}`;
  }

  // Non-blocking - just show prompt and that it was started
  return d`${promptSection}\n\n**Status:** Started (non-blocking)`;
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
