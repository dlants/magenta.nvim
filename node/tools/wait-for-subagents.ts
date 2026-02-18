import { d, withBindings, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Nvim } from "../nvim/nvim-node";
import type {
  StaticTool,
  ToolName,
  GenericToolRequest,
  CompletedToolInfo,
} from "./types.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import type { ThreadId } from "../chat/types";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Chat } from "../chat/chat.ts";
import { renderPendingApprovals } from "./render-pending-approvals.ts";

export type Input = {
  threadIds: ThreadId[];
};

export type ToolRequest = GenericToolRequest<"wait_for_subagents", Input>;

export type Msg =
  | {
      type: "check-threads";
    }
  | {
      type: "finish";
      result: ProviderToolResult;
    };

export type State =
  | {
      state: "waiting";
    }
  | {
      state: "done";
      result: ProviderToolResult;
    };

export class WaitForSubagentsTool implements StaticTool {
  toolName = "wait_for_subagents" as const;
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
      state: "waiting",
    };

    setTimeout(() => {
      if (this.aborted) return;
      this.checkThreads();
    });
  }

  private checkThreads() {
    if (this.state.state !== "waiting" || this.aborted) {
      return;
    }

    const threadIds = this.request.input.threadIds;
    const results: { threadId: ThreadId; result: Result<string> }[] = [];

    for (const threadId of threadIds) {
      const threadResult = this.context.chat.getThreadResult(threadId);
      switch (threadResult.status) {
        case "done":
          results.push({ threadId, result: threadResult.result });
          break;

        case "pending":
          return;

        default:
          assertUnreachable(threadResult);
      }
    }

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
              text: `\
All subagents completed:
${results
  .map(({ threadId, result }) => {
    switch (result.status) {
      case "ok":
        return `- Thread ${threadId}: ${result.value}`;
      case "error":
        return `- Thread ${threadId}: ❌ Error: ${result.error}`;
      default:
        assertUnreachable(result);
    }
  })
  .join("\n")}`,
            },
          ],
        },
      },
    };
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  isPendingUserAction(): boolean {
    if (this.state.state !== "waiting") return false;
    for (const threadId of this.request.input.threadIds) {
      if (
        this.context.chat.getThreadPendingApprovalTools(threadId).length > 0
      ) {
        return true;
      }
    }
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
      case "check-threads":
        this.checkThreads();
        return;

      case "finish":
        if (this.state.state === "done") {
          return;
        }
        this.state = {
          state: "done",
          result: msg.result,
        };
        return;

      default:
        assertUnreachable(msg);
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
            {
              type: "text",
              text: `Waiting for ${this.request.input.threadIds.length} subagent(s) to complete...`,
            },
          ],
        },
      };
    }

    return this.state.result;
  }

  renderSummary() {
    switch (this.state.state) {
      case "waiting": {
        const threadIds = this.request.input.threadIds;
        const threadStatusLines = threadIds.map((threadId) =>
          this.renderThreadStatus(threadId),
        );

        return d`⏸️⏳ Waiting for ${threadIds.length.toString()} subagent(s):
${threadStatusLines}`;
      }
      case "done":
        return renderCompletedSummary(
          {
            request: this.request as CompletedToolInfo["request"],
            result: this.state.result,
          },
          this.context.dispatch,
        );
    }
  }

  private renderThreadStatus(threadId: ThreadId): VDOMNode {
    const summary = this.context.chat.getThreadSummary(threadId);
    const displayName = this.context.chat.getThreadDisplayName(threadId);

    let statusText: string;
    switch (summary.status.type) {
      case "missing":
        statusText = `- ${displayName}: ❓ not found`;
        break;

      case "pending":
        statusText = `- ${displayName}: ⏳ initializing`;
        break;

      case "running":
        statusText = `- ${displayName}: ⏳ ${summary.status.activity}`;
        break;

      case "stopped":
        statusText = `- ${displayName}: ⏹️ stopped (${summary.status.reason})`;
        break;

      case "yielded": {
        const lineCount = summary.status.response.split("\n").length;
        statusText = `- ${displayName}: ✅ ${lineCount.toString()} lines`;
        break;
      }

      case "error": {
        const truncatedError =
          summary.status.message.length > 50
            ? summary.status.message.substring(0, 47) + "..."
            : summary.status.message;
        statusText = `- ${displayName}: ❌ error: ${truncatedError}`;
        break;
      }

      default:
        return assertUnreachable(summary.status);
    }

    const pendingApprovals = renderPendingApprovals(
      this.context.chat,
      threadId,
    );
    return withBindings(
      d`${statusText}\n${pendingApprovals ? d`${pendingApprovals}` : d``}`,
      {
        "<CR>": () =>
          this.context.dispatch({
            type: "chat-msg",
            msg: {
              type: "select-thread",
              id: threadId,
            },
          }),
      },
    );
  }
}

function isError(info: CompletedToolInfo): boolean {
  return info.result.result.status === "error";
}

function getStatusEmoji(info: CompletedToolInfo): string {
  return isError(info) ? "❌" : "✅";
}

export function renderCompletedSummary(
  info: CompletedToolInfo,
  _dispatch: Dispatch<RootMsg>,
): VDOMNode {
  const input = info.request.input as Input;
  const status = getStatusEmoji(info);
  const count = input.threadIds?.length ?? 0;

  return d`⏳${status} wait_for_subagents (${count.toString()} threads)`;
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
