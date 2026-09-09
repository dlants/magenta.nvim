import type {
  CompletedToolInfo,
  DisplayContext,
  SpawnSubagents,
  ThreadId,
  ToolRequestId,
  ToolRequest as UnionToolRequest,
  UnresolvedFilePath,
} from "@magenta/server";
import { renderPendingApprovals } from "../capabilities/render-pending-approvals.ts";
import type { Chat } from "../chat/chat.ts";
import type { Msg as ThreadMsg, ToolViewState } from "../chat/thread.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Dispatch } from "../tea/tea.ts";
import { d, type VDOMNode, withBindings } from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { formatTokens } from "../utils/tokens.ts";

type Input = SpawnSubagents.Input;
type SubagentEntry = SpawnSubagents.SubagentEntry;
type PartialInput = SpawnSubagents.PartialSpawnSubagentsInput;
type PartialEntry = SpawnSubagents.PartialSubagentEntry;

const PROMPT_TAIL_MAX = 100;

function promptTail(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const tail =
    collapsed.length > PROMPT_TAIL_MAX
      ? `…${collapsed.slice(collapsed.length - PROMPT_TAIL_MAX)}`
      : collapsed;
  return `(${formatTokens(text.length)}) ${tail}`;
}

function isDockerEntry(entry: PartialEntry): boolean {
  return (
    entry.environment === "docker" ||
    entry.environment === "docker_unsupervised"
  );
}

function agentMetaLine(entry: PartialEntry, statusIcon?: string): string {
  const parts: string[] = [];
  if (isDockerEntry(entry)) parts.push("🐳");
  if (statusIcon) parts.push(statusIcon);
  if (entry.agentType && entry.agentType !== "default")
    parts.push(entry.agentType);
  if (entry.environment && entry.environment !== "host")
    parts.push(`[${entry.environment}]`);
  if (entry.dockerfile) parts.push(`dockerfile=${entry.dockerfile}`);
  if (entry.directory) parts.push(`dir=${entry.directory}`);
  if (entry.workspacePath) parts.push(`ws=${entry.workspacePath}`);
  if (parts.length === 0) parts.push("agent");
  return parts.join(" ");
}

type AgentExtras = {
  statusIcon?: string | undefined;
  statusDetail?: string | undefined;
  pendingApprovals?: VDOMNode | undefined;
  expandedContent?: VDOMNode | undefined;
  bindings?: Record<string, () => void> | undefined;
};

function renderFileRows(
  files: string[],
  indent: string,
  fileBinding?: (path: string) => Record<string, () => void>,
): VDOMNode {
  return d`${files.map((path) => {
    const row = d`${indent}- ${path}\n`;
    return fileBinding ? withBindings(row, fileBinding(path)) : row;
  })}`;
}

function renderAgentBlock(
  entry: PartialEntry,
  extras: AgentExtras | undefined,
  fileBinding?: (path: string) => Record<string, () => void>,
): VDOMNode {
  const metaLine = agentMetaLine(entry, extras?.statusIcon);
  const detail = extras?.statusDetail ? ` : ${extras.statusDetail}` : "";
  const blockParts: VDOMNode[] = [d`  - ${metaLine}${detail}\n`];

  if (entry.prompt) {
    blockParts.push(d`    prompt: ${promptTail(entry.prompt)}\n`);
  }
  if (entry.contextFiles && entry.contextFiles.length > 0) {
    blockParts.push(d`    contextFiles:\n`);
    blockParts.push(renderFileRows(entry.contextFiles, "      ", fileBinding));
  }
  if (extras?.pendingApprovals) {
    blockParts.push(d`${extras.pendingApprovals}\n`);
  }
  if (extras?.expandedContent) {
    blockParts.push(d`${extras.expandedContent}\n`);
  }

  const block = d`${blockParts}`;
  return extras?.bindings ? withBindings(block, extras.bindings) : block;
}

export function renderSpawnLayout(
  input: PartialInput,
  opts?: {
    agentExtras?: (idx: number) => AgentExtras;
    fileBinding?: (path: string) => Record<string, () => void>;
  },
): VDOMNode {
  const parts: VDOMNode[] = [];

  if (input.sharedPrompt) {
    parts.push(d`sharedPrompt: ${promptTail(input.sharedPrompt)}\n`);
  }
  if (input.sharedContextFiles && input.sharedContextFiles.length > 0) {
    parts.push(d`sharedContextFiles:\n`);
    parts.push(
      renderFileRows(input.sharedContextFiles, "  ", opts?.fileBinding),
    );
  }
  if (input.agents.length > 0) {
    parts.push(d`agents:\n`);
    input.agents.forEach((entry, idx) => {
      parts.push(
        renderAgentBlock(entry, opts?.agentExtras?.(idx), opts?.fileBinding),
      );
    });
  }

  return d`${parts}`;
}

type AgentRowRenderInfo = {
  entry: SubagentEntry;
  statusIcon: string;
  statusDetail?: string | undefined;
  threadId?: ThreadId | undefined;
  pendingApprovals?: VDOMNode | undefined;
};

function resolveAgentRowFromProgress(
  element: SpawnSubagents.SpawnSubagentsProgress["elements"][0],
  chat: Chat,
): AgentRowRenderInfo {
  const entry = element.entry;

  switch (element.state.status) {
    case "pending":
      return { entry, statusIcon: "⏸️" };
    case "provisioning":
      return { entry, statusIcon: "📦", statusDetail: element.state.message };
    case "spawn-error":
      return { entry, statusIcon: "❌", statusDetail: element.state.error };
    case "spawned":
      return resolveAgentRowFromThread(entry, element.state.threadId, chat);
    default:
      assertUnreachable(element.state);
  }
}

function resolveAgentRowFromThread(
  entry: SubagentEntry,
  threadId: ThreadId,
  chat: Chat,
): AgentRowRenderInfo {
  const summary = chat.getThreadSummary(threadId);
  let statusIcon: string;
  let statusDetail: string | undefined;

  switch (summary.status.type) {
    case "missing":
      statusIcon = "❓";
      statusDetail = "not found";
      break;
    case "pending":
      statusIcon = "⏳";
      statusDetail = "initializing";
      break;
    case "running":
      statusIcon = "⏳";
      statusDetail = summary.status.activity;
      break;
    case "stopped":
      statusIcon = "⏹️";
      statusDetail = `stopped (${summary.status.reason})`;
      break;
    case "yielded": {
      statusIcon = "✅";
      statusDetail = formatTokens(summary.status.response.length);
      break;
    }
    case "error": {
      statusIcon = "❌";
      statusDetail =
        summary.status.message.length > 50
          ? `${summary.status.message.substring(0, 47)}...`
          : summary.status.message;
      break;
    }
    default:
      assertUnreachable(summary.status);
  }

  const pendingApprovals = renderPendingApprovals(chat, threadId);
  return { entry, statusIcon, statusDetail, threadId, pendingApprovals };
}

function resolveAgentRowFromResult(
  agent: SpawnSubagents.StructuredResult["agents"][0],
  entry: SubagentEntry,
  chat: Chat,
): AgentRowRenderInfo {
  if (agent.threadId) {
    return resolveAgentRowFromThread(entry, agent.threadId, chat);
  }

  const statusIcon = agent.ok ? "✅" : "❌";
  const statusDetail = agent.responseBody
    ? formatTokens(agent.responseBody.length)
    : undefined;
  return { entry, statusIcon, statusDetail, threadId: agent.threadId };
}

function threadBindings(
  info: AgentRowRenderInfo,
  dispatch: Dispatch<RootMsg>,
): Record<string, () => void> {
  if (!info.threadId) return {};
  const threadId = info.threadId;
  return {
    "<CR>": () =>
      dispatch({
        type: "select-thread-effect",
        id: threadId,
      }),
  };
}

export function renderSummary(
  request: UnionToolRequest,
  _displayContext: DisplayContext,
): VDOMNode {
  const input = request.input as Input;
  const count = input.agents?.length ?? 0;
  return d`🤖 spawn_subagents: ${count.toString()} agent${count === 1 ? "" : "s"}`;
}

function fileBindingFactory(
  threadDispatch: Dispatch<ThreadMsg>,
): (path: string) => Record<string, () => void> {
  return (path: string) => ({
    "<CR>": () =>
      threadDispatch({
        type: "open-edit-file",
        filePath: path as UnresolvedFilePath,
      }),
  });
}

export function renderInput(
  _request: UnionToolRequest,
  _displayContext: DisplayContext,
  _expanded: boolean,
): VDOMNode | undefined {
  // The structured layout is rendered by renderProgress (in-flight) and
  // renderResult (completed); the streaming phase is covered by
  // renderStreamdedTool. Returning undefined avoids duplicating it here.
  return undefined;
}

export function renderProgress(
  request: UnionToolRequest,
  progress: SpawnSubagents.SpawnSubagentsProgress | undefined,
  context: {
    dispatch: Dispatch<RootMsg>;
    threadDispatch: Dispatch<ThreadMsg>;
    chat: Chat;
  },
  _expanded: boolean,
  toolViewState: ToolViewState,
  toolRequestId: ToolRequestId,
): VDOMNode | undefined {
  if (!progress || progress.elements.length === 0) {
    return undefined;
  }

  const input = request.input as Input;
  const fileBinding = fileBindingFactory(context.threadDispatch);

  return renderSpawnLayout(input, {
    fileBinding,
    agentExtras: (idx) => {
      const element = progress.elements[idx];
      const info = resolveAgentRowFromProgress(element, context.chat);
      const agentKey = String(idx);
      const itemExpanded =
        toolViewState.progressItemExpanded?.[agentKey] || false;
      const entry = input.agents[idx];
      const expandedContent =
        itemExpanded && entry?.prompt ? d`${entry.prompt}` : undefined;

      return {
        statusIcon: info.statusIcon,
        statusDetail: info.statusDetail,
        pendingApprovals: info.pendingApprovals,
        expandedContent,
        bindings: {
          ...threadBindings(info, context.dispatch),
          "=": () =>
            context.threadDispatch({
              type: "toggle-tool-progress-item",
              toolRequestId,
              itemKey: agentKey,
            }),
        },
      };
    },
  });
}

export function renderResultSummary(info: CompletedToolInfo): VDOMNode {
  const input = info.request.input as Input;
  const result = info.result.result;
  const totalAgents = input.agents?.length ?? 0;

  if (result.status === "error") {
    const errorPreview =
      result.error.length > 50
        ? `${result.error.substring(0, 50)}...`
        : result.error;
    return d`${errorPreview}`;
  }

  return d`${totalAgents.toString()} agent${totalAgents === 1 ? "" : "s"}`;
}

export function renderResult(
  info: CompletedToolInfo,
  context: {
    dispatch: Dispatch<RootMsg>;
    threadDispatch: Dispatch<ThreadMsg>;
    chat: Chat;
  },
  toolViewState: ToolViewState,
  toolRequestId: ToolRequestId,
): VDOMNode | undefined {
  const input = info.request.input as Input;
  const result = info.result.result;

  if (result.status === "error") {
    if (toolViewState.resultExpanded) {
      return d`**Error:**\n${result.error}`;
    }
    return undefined;
  }

  if (info.structuredResult?.toolName !== "spawn_subagents") return undefined;
  const sr = info.structuredResult as SpawnSubagents.StructuredResult;

  const fileBinding = fileBindingFactory(context.threadDispatch);

  return renderSpawnLayout(input, {
    fileBinding,
    agentExtras: (idx) => {
      const agent = sr.agents[idx];
      if (!agent) return {};
      const entry = input.agents[idx] ?? { prompt: agent.prompt };
      const agentKey = String(idx);
      const itemExpanded =
        toolViewState.resultItemExpanded?.[agentKey] || false;
      const rowInfo = resolveAgentRowFromResult(agent, entry, context.chat);

      let expandedContent: VDOMNode | undefined;
      if (itemExpanded) {
        const promptText = entry.prompt ?? agent.prompt;
        const responseText = agent.responseBody;
        if (promptText && responseText) {
          expandedContent = d`**Prompt:**\n${promptText}\n\n**Response:**\n${responseText}`;
        } else if (promptText) {
          expandedContent = d`**Prompt:**\n${promptText}`;
        } else if (responseText) {
          expandedContent = d`${responseText}`;
        }
      }

      return {
        statusIcon: rowInfo.statusIcon,
        statusDetail: rowInfo.statusDetail,
        pendingApprovals: rowInfo.pendingApprovals,
        expandedContent,
        bindings: {
          ...threadBindings(rowInfo, context.dispatch),
          "=": () =>
            context.threadDispatch({
              type: "toggle-tool-result-item",
              toolRequestId,
              itemKey: agentKey,
            }),
        },
      };
    },
  });
}
