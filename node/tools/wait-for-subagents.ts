import { d, withBindings, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";

import type {
  ToolName,
  GenericToolRequest,
  CompletedToolInfo,
  ToolInvocation,
  DisplayContext,
  ToolRequest as UnionToolRequest,
} from "./types.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import type { ThreadId } from "../chat/types";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Chat } from "../chat/chat.ts";
import { renderPendingApprovals } from "./render-pending-approvals.ts";
import type { ThreadManager } from "./thread-manager.ts";

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

export function renderInFlightSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
  progress?: WaitForSubagentsProgress,
): VDOMNode {
  const input = request.input as Input;
  const count = input.threadIds.length;
  const completed = progress?.completedThreadIds.length ?? 0;
  return d`⏸️⏳ Waiting for ${count.toString()} subagent(s): ${completed.toString()}/${count.toString()} done`;
}

export function renderInFlightPreview(
  request: UnionToolRequest,
  _progress: WaitForSubagentsProgress | undefined,
  context: {
    dispatch: Dispatch<RootMsg>;
    chat?: Chat;
  },
): VDOMNode {
  if (!context.chat) return d``;

  const threadIds = (request.input as Input).threadIds;
  const threadStatusViews: VDOMNode[] = threadIds.map((threadId) => {
    const summary = context.chat!.getThreadSummary(threadId);
    const displayName = context.chat!.getThreadDisplayName(threadId);

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

    const pendingApprovals = renderPendingApprovals(context.chat!, threadId);
    return withBindings(
      d`${statusText}\n${pendingApprovals ? d`${pendingApprovals}` : d``}`,
      {
        "<CR>": () =>
          context.dispatch({
            type: "chat-msg",
            msg: {
              type: "select-thread",
              id: threadId,
            },
          }),
      },
    );
  });

  return d`${threadStatusViews}`;
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
