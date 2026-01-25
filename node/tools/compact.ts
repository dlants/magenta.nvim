import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
  CompactReplacement,
} from "../providers/provider-types.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type {
  GenericToolRequest,
  StaticTool,
  ToolName,
  CompletedToolInfo,
} from "./types.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { Thread } from "../chat/thread.ts";

export type Msg = {
  type: "finish";
};

export type State =
  | {
      state: "pending";
    }
  | {
      state: "done";
      result: ProviderToolResult;
    };

export class CompactTool implements StaticTool {
  toolName = "compact" as const;
  public state: State;
  public aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public context: {
      nvim: Nvim;
      thread: Thread;
      myDispatch: Dispatch<Msg>;
    },
  ) {
    this.state = { state: "pending" };

    try {
      this.doCompact();
    } catch (error) {
      this.state = {
        state: "done",
        result: {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "error",
            error:
              error instanceof Error
                ? error.message
                : "Compact operation failed",
          },
        },
      };
    }
  }

  doCompact() {
    const replacements: CompactReplacement[] = this.request.input.replacements;

    // Apply the compaction to the agent
    this.context.thread.agent.compact(replacements);

    // Dispatch finish message after the current task completes
    // This ensures the conversation state has been set to tool_use
    // before we try to handle the tool message
    queueMicrotask(() => {
      this.context.myDispatch({ type: "finish" });
    });
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  isPendingUserAction(): boolean {
    return false;
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
    switch (msg.type) {
      case "finish":
        this.state = {
          state: "done",
          result: {
            type: "tool_result",
            id: this.request.id,
            result: this.aborted
              ? {
                  status: "error",
                  error: "Compact operation was aborted.",
                }
              : {
                  status: "ok",
                  value: [
                    { type: "text", text: "Thread compacted successfully." },
                  ],
                },
          },
        };
        return;
    }
  }

  getToolResult(): ProviderToolResult {
    if (this.state.state == "pending") {
      return {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "ok",
          value: [{ type: "text", text: "Compact request is pending." }],
        },
      };
    }

    return this.state.result;
  }

  renderSummary() {
    switch (this.state.state) {
      case "pending":
        return d`Compacting thread...`;

      case "done":
        return renderCompletedSummary({
          request: this.request as CompletedToolInfo["request"],
          result: this.state.result,
        });
    }
  }
}

function isError(result: ProviderToolResult): boolean {
  return result.result.status === "error";
}

function getStatusEmoji(result: ProviderToolResult): string {
  return isError(result) ? "❌" : "✅";
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const status = getStatusEmoji(info.result);
  return d`📦${status} compact`;
}

export const spec: ProviderToolSpec = {
  name: "compact" as ToolName,
  description: `Compact the conversation thread by replacing message ranges with summaries.

Use this tool when:
- The thread is getting long and you want to reduce context size
- There are repetitive tool calls or content that can be summarized
- You want to preserve important information while removing verbose details

Checkpoints are markers in the conversation (format: <checkpoint:xxxxxx>) that appear at the end of user messages.

Each replacement specifies:
- from: checkpoint id to start from (omit to start from beginning of thread)
- to: checkpoint id to end at (omit to go to end of thread)
- summary: text to replace the range with (empty string deletes the range)

The tool will:
- Replace content between checkpoints with your summary
- Strip system reminders from user messages in the affected range
- Strip thinking blocks from assistant messages in the affected range
- Preserve checkpoint markers for future compactions

If you want to continue with a specific action after compaction, use the continuation parameter.`,
  input_schema: {
    type: "object",
    properties: {
      replacements: {
        type: "array",
        items: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description:
                "Checkpoint ID to start replacement from. Omit to start from beginning of thread.",
            },
            to: {
              type: "string",
              description:
                "Checkpoint ID to end replacement at. Omit to replace to end of thread.",
            },
            summary: {
              type: "string",
              description:
                "Text to replace the range with. Use empty string to delete the range.",
            },
          },
          required: ["summary"],
        },
        description: "Array of replacements to apply to the thread.",
      },
      continuation: {
        type: "string",
        description:
          "Optional message to append after compaction. The agent will continue streaming after this message is added.",
      },
    },
    required: ["replacements"],
  },
};

export type Input = {
  replacements: CompactReplacement[];
  continuation?: string;
};

export type ToolRequest = GenericToolRequest<"compact", Input>;

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (!Array.isArray(input.replacements)) {
    return {
      status: "error",
      error: `expected req.input.replacements to be an array but it was ${JSON.stringify(input.replacements)}`,
    };
  }

  for (let i = 0; i < input.replacements.length; i++) {
    const r = input.replacements[i] as Record<string, unknown>;
    if (typeof r !== "object" || r === null) {
      return {
        status: "error",
        error: `expected req.input.replacements[${i}] to be an object`,
      };
    }

    if (r.from !== undefined && typeof r.from !== "string") {
      return {
        status: "error",
        error: `expected req.input.replacements[${i}].from to be a string or undefined`,
      };
    }

    if (r.to !== undefined && typeof r.to !== "string") {
      return {
        status: "error",
        error: `expected req.input.replacements[${i}].to to be a string or undefined`,
      };
    }

    if (typeof r.summary !== "string") {
      return {
        status: "error",
        error: `expected req.input.replacements[${i}].summary to be a string`,
      };
    }
  }

  if (
    input.continuation !== undefined &&
    typeof input.continuation !== "string"
  ) {
    return {
      status: "error",
      error: `expected req.input.continuation to be a string or undefined`,
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
