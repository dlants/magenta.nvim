import { d, withBindings, type VDOMNode } from "../tea/view.ts";
import type {
  DisplayContext,
  CompletedToolInfo,
  ToolRequest as UnionToolRequest,
} from "../tools/types.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import type { ThreadId } from "../chat/types.ts";
import type { Chat } from "../chat/chat.ts";
import type { WaitForSubagentsProgress } from "../tools/wait-for-subagents.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { renderPendingApprovals } from "../tools/render-pending-approvals.ts";

type Input = {
  threadIds: ThreadId[];
};

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