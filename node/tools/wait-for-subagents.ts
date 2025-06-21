import { d, withBindings, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { StaticTool, ToolName } from "./types.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import type { ThreadId } from "../chat/thread.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Chat } from "../chat/chat.ts";

export type Msg = {
  type: "check-threads";
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

  constructor(
    public request: Extract<
      StaticToolRequest,
      { toolName: "wait_for_subagents" }
    >,
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
      this.checkThreads();
    });
  }

  private checkThreads() {
    if (this.state.state !== "waiting") {
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

  abort() {
    if (this.state.state === "waiting") {
      this.state = {
        state: "done",
        result: {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "error",
            error: "Wait for subagents was aborted",
          },
        },
      };
    }
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "check-threads":
        this.checkThreads();
        return;

      default:
        assertUnreachable(msg.type);
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

  view() {
    switch (this.state.state) {
      case "waiting":
        return this.renderWaitingView();
      case "done": {
        const result = this.state.result.result;
        if (result.status === "error") {
          return d`⏸️❌ ${result.error}`;
        } else {
          return d`⏸️✅ All subagents completed.`;
        }
      }
    }
  }

  private renderWaitingView() {
    const threadIds = this.request.input.threadIds;
    const threadStatusLines = threadIds.map((threadId) =>
      this.renderThreadStatus(threadId),
    );

    return d`⏸️⏳ Waiting for ${threadIds.length.toString()} subagent(s):
${threadStatusLines}`;
  }

  private renderThreadStatus(threadId: ThreadId): VDOMNode {
    const summary = this.context.chat.getThreadSummary(threadId);
    const title = summary.title || "[Untitled]";

    let statusText: string;
    switch (summary.status.type) {
      case "missing":
        statusText = `- ${threadId} ${title}: ❓ not found`;
        break;

      case "pending":
        statusText = `- ${threadId} ${title}: ⏳ initializing`;
        break;

      case "running":
        statusText = `- ${threadId} ${title}: ⏳ ${summary.status.activity}`;
        break;

      case "stopped":
        statusText = `- ${threadId} ${title}: ⏹️ stopped (${summary.status.reason})`;
        break;

      case "yielded": {
        const truncatedResponse =
          summary.status.response.length > 50
            ? summary.status.response.substring(0, 47) + "..."
            : summary.status.response;
        statusText = `- ${threadId} ${title}: ✅ yielded: ${truncatedResponse}`;
        break;
      }

      case "error": {
        const truncatedError =
          summary.status.message.length > 50
            ? summary.status.message.substring(0, 47) + "..."
            : summary.status.message;
        statusText = `- ${threadId} ${title}: ❌ error: ${truncatedError}`;
        break;
      }

      default:
        return assertUnreachable(summary.status);
    }

    return withBindings(d`${statusText}\n`, {
      "<CR>": () =>
        this.context.dispatch({
          type: "chat-msg",
          msg: {
            type: "select-thread",
            id: threadId,
          },
        }),
    });
  }

  displayInput(): string {
    const threadIds = this.request.input.threadIds
      .map((id) => `"${id.toString()}"`)
      .join(", ");

    return `wait_for_subagents: {
    threadIds: [${threadIds}]
}`;
  }
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
          type: "number",
        },
        description: "Array of thread IDs to wait for completion",
        minItems: 1,
      },
    },
    required: ["threadIds"],
    additionalProperties: false,
  },
};

export type Input = {
  threadIds: ThreadId[];
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

  if (!input.threadIds.every((item) => typeof item === "number")) {
    return {
      status: "error",
      error: `expected all items in req.input.threadIds to be numbers but they were ${JSON.stringify(input.threadIds)}`,
    };
  }

  return {
    status: "ok",
    value: {
      threadIds: input.threadIds as ThreadId[],
    },
  };
}
