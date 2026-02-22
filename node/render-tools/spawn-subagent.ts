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
import { renderPendingApprovals } from "../tools/render-pending-approvals.ts";
import type { SpawnSubagentProgress } from "../tools/spawn-subagent.ts";

type Input = {
  prompt: string;
  contextFiles?: UnresolvedFilePath[];
  agentType?: AgentType;
  blocking?: boolean;
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

export function renderInFlightSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
  progress?: SpawnSubagentProgress,
): VDOMNode {
  const input = request.input as Input;
  const typeLabel = agentTypeLabel(input.agentType);

  if (progress?.threadId) {
    return d`🚀⏳ spawn_subagent${typeLabel} (blocking): spawned ${progress.threadId}`;
  }

  return d`🚀⚙️ spawn_subagent${typeLabel}: ${truncate(input.prompt)}`;
}

export function renderInFlightPreview(
  _request: UnionToolRequest,
  progress: SpawnSubagentProgress | undefined,
  context: {
    dispatch: Dispatch<RootMsg>;
    chat?: Chat;
  },
): VDOMNode {
  if (!context.chat || !progress?.threadId) {
    return d``;
  }

  const threadId = progress.threadId;
  const summary = context.chat.getThreadSummary(threadId);
  const displayName = context.chat.getThreadDisplayName(threadId);

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
      assertUnreachable(summary.status);
  }

  const pendingApprovals = renderPendingApprovals(context.chat, threadId);

  return withBindings(
    d`${displayName}: ${statusText}${pendingApprovals ? d`${pendingApprovals}` : d``}`,
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

  const resultText =
    result.value[0]?.type === "text" ? result.value[0].text : "";
  const match = resultText.match(/threadId: ([a-f0-9-]+)/);
  const threadId = match ? (match[1] as ThreadId) : undefined;

  const isBlocking = resultText.includes("completed:");

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

  const completedMatch = resultText.match(/completed:\n([\s\S]*)/);
  if (completedMatch) {
    const response = completedMatch[1];
    return d`${promptSection}\n\n**Response:**\n${response}`;
  }

  return d`${promptSection}\n\n**Status:** Started (non-blocking)`;
}