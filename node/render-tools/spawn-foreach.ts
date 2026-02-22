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
import type { AgentType } from "../providers/system-prompt.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { renderPendingApprovals } from "../capabilities/render-pending-approvals.ts";
import type { Result } from "../utils/result.ts";

type ForEachElement = string & { __forEachElement: true };

type Input = {
  prompt: string;
  elements: ForEachElement[];
  contextFiles?: UnresolvedFilePath[] | undefined;
  agentType?: AgentType | undefined;
};

type SpawnForeachElementProgress =
  | { status: "pending" }
  | { status: "running"; threadId: ThreadId }
  | { status: "completed"; threadId?: ThreadId; result: Result<string> };

type SpawnForeachProgress = {
  elements: Array<{
    element: ForEachElement;
    state: SpawnForeachElementProgress;
  }>;
};

export function renderInFlightSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
  progress?: SpawnForeachProgress,
): VDOMNode {
  const input = request.input as Input;
  const agentTypeText =
    input.agentType && input.agentType !== "default"
      ? ` (${input.agentType})`
      : "";

  if (!progress || progress.elements.length === 0) {
    return d`🤖⚙️ Foreach subagents${agentTypeText}: preparing...`;
  }

  const completed = progress.elements.filter(
    (el) => el.state.status === "completed",
  ).length;
  const total = progress.elements.length;

  const elementViews = progress.elements.map((entry) => {
    switch (entry.state.status) {
      case "completed": {
        const status = entry.state.result.status === "ok" ? "✅" : "❌";
        return d`  - ${entry.element}: ${status}\n`;
      }
      case "running":
        return d`  - ${entry.element}: ⏳\n`;
      case "pending":
        return d`  - ${entry.element}: ⏸️\n`;
      default:
        return assertUnreachable(entry.state);
    }
  });

  return d`🤖⏳ Foreach subagents${agentTypeText} (${completed.toString()}/${total.toString()}):
${elementViews}`;
}

export function renderInFlightPreview(
  _request: UnionToolRequest,
  progress: SpawnForeachProgress | undefined,
  context: {
    dispatch: Dispatch<RootMsg>;
    chat?: Chat;
  },
): VDOMNode {
  if (!context.chat || !progress || progress.elements.length === 0) {
    return d``;
  }

  const elementViews = progress.elements.map((entry) => {
    switch (entry.state.status) {
      case "completed": {
        const status = entry.state.result.status === "ok" ? "✅" : "❌";
        if (entry.state.threadId) {
          return withBindings(d`  - ${entry.element}: ${status}\n`, {
            "<CR>": () =>
              context.dispatch({
                type: "chat-msg",
                msg: {
                  type: "select-thread",
                  id:
                    entry.state.status === "completed"
                      ? entry.state.threadId!
                      : ("" as ThreadId),
                },
              }),
          });
        }
        return d`  - ${entry.element}: ${status}\n`;
      }
      case "running": {
        if (!entry.state.threadId) {
          return d`  - ${entry.element}: 🚀\n`;
        }
        const summary = context.chat!.getThreadSummary(entry.state.threadId);
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
          case "yielded": {
            const lineCount = summary.status.response.split("\n").length;
            statusText = `✅ ${lineCount.toString()} lines`;
            break;
          }
          case "error": {
            const truncatedError =
              summary.status.message.length > 50
                ? summary.status.message.substring(0, 47) + "..."
                : summary.status.message;
            statusText = `❌ error: ${truncatedError}`;
            break;
          }
          default:
            return assertUnreachable(summary.status);
        }
        const pendingApprovals = renderPendingApprovals(
          context.chat!,
          entry.state.threadId,
        );
        return withBindings(
          d`  - ${entry.element}: ${statusText}\n${pendingApprovals ? d`${pendingApprovals}` : d``}`,
          {
            "<CR>": () =>
              context.dispatch({
                type: "chat-msg",
                msg: {
                  type: "select-thread",
                  id:
                    entry.state.status === "running"
                      ? entry.state.threadId
                      : ("" as ThreadId),
                },
              }),
          },
        );
      }
      case "pending":
        return d`  - ${entry.element}: ⏸️\n`;
      default:
        return assertUnreachable(entry.state);
    }
  });

  return d`${elementViews}`;
}

export function renderCompletedSummary(
  info: CompletedToolInfo,
  _dispatch: Dispatch<RootMsg>,
): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;

  const agentTypeText =
    input.agentType && input.agentType !== "default"
      ? ` (${input.agentType})`
      : "";
  const totalElements = input.elements?.length ?? 0;
  const status = result.status === "error" ? "❌" : "✅";

  return d`🤖${status} Foreach subagents${agentTypeText} (${totalElements.toString()}/${totalElements.toString()})`;
}

export function renderCompletedPreview(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;

  if (result.status === "error") {
    return d``;
  }

  const elements = input.elements || [];
  const maxPreviewElements = 3;
  const previewElements = elements.slice(0, maxPreviewElements);
  const remaining = elements.length - maxPreviewElements;

  const elementList = previewElements.join(", ");
  const suffix = remaining > 0 ? ` (+${remaining} more)` : "";

  return d`Elements: ${elementList}${suffix}`;
}

export function renderCompletedDetail(
  info: CompletedToolInfo,
  dispatch: Dispatch<RootMsg>,
): VDOMNode {
  const result = info.result.result;

  if (result.status === "error") {
    return d`**Error:**\n${result.error}`;
  }

  const resultText =
    result.value[0]?.type === "text" ? result.value[0].text : "";

  const elementThreadsMatch = resultText.match(
    /ElementThreads:\n([\s\S]*?)\n\n/,
  );
  const elementLines = elementThreadsMatch
    ? elementThreadsMatch[1].split("\n").filter((line) => line.includes("::"))
    : [];

  const elementViews = elementLines.map((line) => {
    const parts = line.split("::");
    if (parts.length >= 3) {
      const element = parts[0];
      const threadId = parts[1] as ThreadId;
      const status = parts[2] === "ok" ? "✅" : "❌";

      return withBindings(d`  - ${element}: ${status}\n`, {
        "<CR>": () => {
          dispatch({
            type: "chat-msg",
            msg: {
              type: "select-thread",
              id: threadId,
            },
          });
        },
      });
    }
    return d`  - ${line}\n`;
  });

  return d`${elementViews}`;
}
