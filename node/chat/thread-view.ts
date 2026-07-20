import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AbsFilePath,
  type CompactionRecord,
  type CompletedToolInfo,
  type ContextManager,
  displayPath,
  formatToolSpec,
  formatToolSpecs,
  type NativeMessageIdx,
  type ProviderToolSpec,
  renderThreadToMarkdown,
  type ThreadId,
  type ThreadMode,
  type ToolName,
  type ToolRequestId,
} from "@magenta/core";
import {
  type ContextViewContext,
  contextFilesView,
  renderContextUpdate,
  renderGitUpdate,
} from "../context/context-manager.ts";
import type {
  AgentStatus,
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolResult,
  StopReason,
  Usage,
} from "../providers/provider.ts";
import type { SystemPrompt } from "../providers/system-prompt.ts";
import {
  renderToolInput,
  renderToolInputSummaryExpansion,
  renderToolProgress,
  renderToolResult,
  renderToolResultSummary,
  renderToolResultSummaryExpansion,
  renderToolSummary,
} from "../render-tools/index.ts";
import { renderStreamdedTool } from "../render-tools/streaming.ts";
import type { Dispatch } from "../tea/tea.ts";
import {
  d,
  type VDOMNode,
  type View,
  withBindings,
  withExtmark,
} from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { formatTokens } from "../utils/tokens.ts";
import type { Msg, Thread, ToolViewState } from "./thread.ts";

function contextViewCtx(thread: Thread): ContextViewContext {
  return {
    cwd: thread.context.cwd,
    homeDir: thread.context.homeDir,
    nvim: thread.context.nvim,
    options: thread.context.options,
  };
}

/**
 * Helper function to render the animation frame for in-progress operations
 */
const shortErrorMessage = (error: Error): string => {
  const msg = error.message.split("\n")[0].trim();
  return msg.length > 80 ? `${msg.slice(0, 77)}...` : msg;
};

const getAnimationFrame = (sendDate: Date): string => {
  const frameIndex =
    Math.floor((Date.now() - sendDate.getTime()) / 333) %
    MESSAGE_ANIMATION.length;

  return MESSAGE_ANIMATION[frameIndex];
};

/**
 * Helper function to render the status message
 * Composes agent status with thread mode for complete display
 */
export const renderStatus = (
  agentStatus: AgentStatus,
  mode: ThreadMode,
  latestUsage: Usage | undefined,
): VDOMNode => {
  const yieldedResponse = mode.type === "yielded" ? mode.response : undefined;
  // First check mode for thread-specific states
  if (mode.type === "tool_use") {
    return d`Executing tools...`;
  }
  if (yieldedResponse !== undefined) {
    return d`↗️ yielded to parent: ${yieldedResponse}`;
  }
  if (mode.type === "compacting") {
    return d`📦 Compacting thread... (chunk ${String(mode.chunkIndex + 1)} / ${String(mode.totalChunks)})`;
  }

  // Then render based on agent status
  switch (agentStatus.type) {
    case "streaming": {
      if (agentStatus.retryStatus) {
        const secsLeft = Math.max(
          1,
          Math.ceil(
            (agentStatus.retryStatus.nextRetryAt.getTime() - Date.now()) / 1000,
          ),
        );
        const reason = shortErrorMessage(agentStatus.retryStatus.error);
        return d`⏳ Retrying in ${String(secsLeft)}s (attempt ${String(agentStatus.retryStatus.attempt)}) — ${reason}`;
      }
      const waitedMs = Date.now() - agentStatus.lastEventTime.getTime();
      if (waitedMs > 3000) {
        const waitedSecs = Math.floor(waitedMs / 1000);
        return d`Streaming response ${getAnimationFrame(agentStatus.startTime)} (waiting ${String(waitedSecs)}s)`;
      }
      return d`Streaming response ${getAnimationFrame(agentStatus.startTime)}`;
    }
    case "stopped":
      return renderStopReason(agentStatus.stopReason, latestUsage);
    case "error":
      return d`Error ${agentStatus.error.message}${
        agentStatus.error.stack ? `\n${agentStatus.error.stack}` : ""
      }`;
    default:
      assertUnreachable(agentStatus);
  }
};

function renderStopReason(
  stopReason: StopReason,
  usage: Usage | undefined,
): VDOMNode {
  const usageView = usage ? d` ${renderUsage(usage)}` : d``;
  if (stopReason === "aborted") {
    return d`[ABORTED] ${usageView} `;
  }
  return d`Stopped (${stopReason}) ${usageView} `;
}

function renderUsage(usage: Usage): VDOMNode {
  return d`[input: ${usage.inputTokens.toString()}, output: ${usage.outputTokens.toString()}${
    usage.cacheHits !== undefined
      ? d`, cache hits: ${usage.cacheHits.toString()}`
      : ""
  }${
    usage.cacheMisses !== undefined
      ? d`, cache misses: ${usage.cacheMisses.toString()}`
      : ""
  }]`;
}

/**
 * Helper function to determine if context manager view should be shown
 */
const shouldShowContextFiles = (
  agentStatus: AgentStatus,
  mode: ThreadMode,
  contextManager: ContextManager,
): boolean => {
  return (
    agentStatus.type !== "streaming" &&
    mode.type === "normal" &&
    Object.keys(contextManager.files).length > 0
  );
};

/**
 * Helper function to render the system prompt in collapsed/expanded state
 */
const renderSystemPrompt = (
  systemPrompt: SystemPrompt,
  showSystemPrompt: boolean,
  dispatch: Dispatch<Msg>,
): VDOMNode => {
  if (showSystemPrompt) {
    return withBindings(
      withExtmark(d`⚙️ [System Prompt]\n${systemPrompt}`, {
        hl_group: "@comment",
      }),
      {
        "=": () => {
          dispatch({ type: "toggle-system-prompt" });
        },
      },
    );
  } else {
    const tokenDisplay = formatTokens(systemPrompt.length);

    return withBindings(
      withExtmark(d`⚙️ [System Prompt ${tokenDisplay}]`, {
        hl_group: "@comment",
      }),
      {
        "=": () => {
          dispatch({ type: "toggle-system-prompt" });
        },
      },
    );
  }
};

const renderToolDefinitions = (
  specs: ProviderToolSpec[],
  showToolDefinitions: boolean,
  expandedToolDefinitions: { [toolName: string]: boolean },
  dispatch: Dispatch<Msg>,
): VDOMNode => {
  const toggle = () => dispatch({ type: "toggle-tool-definitions" });
  const totalTokens = formatTokens(formatToolSpecs(specs).length);
  const header = withBindings(
    withExtmark(
      d`🔧 [Tool Definitions (${specs.length.toString()}) ${totalTokens}]`,
      { hl_group: "@comment" },
    ),
    { "=": toggle },
  );

  if (!showToolDefinitions) {
    return header;
  }

  const toolViews = specs.map((spec) => {
    const expanded = expandedToolDefinitions[spec.name] || false;
    const tokenDisplay = formatTokens(formatToolSpec(spec).length);
    const toolHeader = withBindings(
      withExtmark(d`# ${spec.name} ${tokenDisplay}\n`, {
        hl_group: "@comment",
      }),
      {
        "=": () =>
          dispatch({ type: "toggle-tool-definition", toolName: spec.name }),
      },
    );
    if (!expanded) return toolHeader;
    return d`${toolHeader}${withExtmark(d`${formatToolSpec(spec)}\n`, { hl_group: "@comment" })}`;
  });

  return d`${header}\n${toolViews}`;
};

function renderCompactionHistory(
  history: CompactionRecord[],
  viewState: Thread["state"]["compactionViewState"],
  dispatch: Dispatch<Msg>,
): VDOMNode {
  if (history.length === 0) return d``;

  return d`${history.map((record, recordIdx) => {
    const rv = viewState[recordIdx];
    const isExpanded = rv?.expanded || false;
    const summaryLen = record.finalSummary?.length ?? 0;
    const status =
      record.finalSummary !== undefined
        ? `summary: ${summaryLen} chars`
        : "⚠️ failed";

    const header = withBindings(
      withExtmark(
        d`📦 [Compaction ${(recordIdx + 1).toString()} — ${record.steps.length.toString()} step${record.steps.length === 1 ? "" : "s"}, ${status}]\n`,
        { hl_group: "@comment" },
      ),
      {
        "=": () => dispatch({ type: "toggle-compaction-record", recordIdx }),
      },
    );

    if (!isExpanded) return header;

    const stepsView = record.steps.map((step, stepIdx) => {
      const stepExpanded = rv?.expandedSteps[stepIdx] || false;
      const stepHeader = withBindings(
        withExtmark(
          d`  📄 [Step ${(step.chunkIndex + 1).toString()} of ${step.totalChunks.toString()}]\n`,
          { hl_group: "@comment" },
        ),
        {
          "=": () =>
            dispatch({
              type: "toggle-compaction-step",
              recordIdx,
              stepIdx,
            }),
        },
      );

      if (!stepExpanded) return stepHeader;

      const { markdown } = renderThreadToMarkdown(step.messages);
      return d`${stepHeader}${withExtmark(d`${markdown}\n`, { hl_group: "@comment" })}`;
    });

    const summaryView =
      record.finalSummary !== undefined
        ? d`  📋 Final Summary:\n${withExtmark(d`${record.finalSummary}\n`, { hl_group: "@comment" })}`
        : d`  ⚠️ Compaction failed — no summary produced\n`;

    return d`${header}${stepsView}${summaryView}`;
  })}`;
}
function editedFilesSummaryView(
  editedFiles: ReadonlyArray<{ path: AbsFilePath; snapshot: string }>,
  thread: Thread,
  dispatch: Dispatch<Msg>,
): VDOMNode {
  if (editedFiles.length === 0) return d``;

  const { cwd, homeDir } = thread.context;
  return d`\n${withExtmark(d`Files edited this turn:\n`, { hl_group: "@comment" })}${editedFiles.map(
    ({ path: filePath, snapshot }) => {
      const display = displayPath(cwd, filePath, homeDir);
      const expanded = thread.state.editedFilesExpanded[filePath];
      const marker = expanded ? "▼" : "▶";
      const row = withBindings(d`  ${marker} ${display}\n`, {
        "=": () => dispatch({ type: "toggle-edited-file-expanded", filePath }),
        "<CR>": () =>
          dispatch({ type: "open-edit-file-diff", filePath, snapshot }),
      });
      const body = expanded
        ? withExtmark(d`${expanded.patch}\n`, { hl_group: "@comment" })
        : d``;
      return d`${row}${body}`;
    },
  )}`;
}

const PENDING_PREVIEW_LINES = 3;
const PENDING_PREVIEW_CHARS = 200;

function renderPendingMessage(
  text: string,
  index: number,
  thread: Thread,
  dispatch: Dispatch<Msg>,
  label = "# ✉️ queued:\n",
): VDOMNode {
  const expanded = thread.state.pendingMessagesExpanded[index] || false;
  const lines = text.split("\n");
  const needsTrim =
    lines.length > PENDING_PREVIEW_LINES || text.length > PENDING_PREVIEW_CHARS;

  let body: VDOMNode;
  let toggle: VDOMNode = d``;
  if (needsTrim && !expanded) {
    let preview = lines.slice(0, PENDING_PREVIEW_LINES).join("\n");
    if (preview.length > PENDING_PREVIEW_CHARS) {
      preview = preview.slice(0, PENDING_PREVIEW_CHARS);
    }
    body = d`${preview}…\n`;
    toggle = withBindings(
      withExtmark(d`[expand]\n`, { hl_group: "@comment" }),
      { "=": () => dispatch({ type: "toggle-pending-message", index }) },
    );
  } else {
    body = d`${text}\n`;
    if (needsTrim) {
      toggle = withBindings(
        withExtmark(d`[collapse]\n`, { hl_group: "@comment" }),
        { "=": () => dispatch({ type: "toggle-pending-message", index }) },
      );
    }
  }

  return withExtmark(
    d`${withExtmark(d`${label}`, {
      hl_group: "@markup.heading.1.markdown",
    })}${body}${toggle}`,
    { hl_group: "CursorLine", hl_eol: true },
  );
}

export const view: View<{
  thread: Thread;
  dispatch: Dispatch<Msg>;
}> = ({ thread, dispatch }) => {
  const threadType = thread.core.state.threadType;
  const titlePrefix = threadType === "docker_root" ? "🐳 " : "";
  const titleView = thread.core.state.title
    ? d`# ${titlePrefix}${thread.core.state.title}`
    : d`# ${titlePrefix}[ Untitled ]`;

  const systemPromptView = renderSystemPrompt(
    thread.core.state.systemPrompt,
    thread.state.showSystemPrompt,
    dispatch,
  );

  const toolDefinitionsView = renderToolDefinitions(
    thread.core.state.toolSpecs,
    thread.state.showToolDefinitions,
    thread.state.expandedToolDefinitions,
    dispatch,
  );

  const messages = thread.getProviderMessages();
  const agentStatus = thread.agent.getState().status;
  const mode = thread.core.state.mode;

  // Show logo when empty and not busy
  const isIdle =
    agentStatus.type === "stopped" && agentStatus.stopReason === "end_turn";
  if (
    messages.length === 0 &&
    isIdle &&
    mode.type === "normal" &&
    thread.core.state.failedSubmit === undefined
  ) {
    return d`\
${titleView}
${systemPromptView}
${toolDefinitionsView}

${LOGO}

magenta is for agentic flow

${contextFilesView(thread.contextManager, contextViewCtx(thread), {
  expanded: thread.state.contextFilesExpanded,
  onToggle: () => dispatch({ type: "toggle-context-files-expanded" }),
})}`;
  }

  const latestUsage = thread.agent.getState().latestUsage;
  const statusView = renderStatus(agentStatus, mode, latestUsage);

  const contextManagerView = shouldShowContextFiles(
    agentStatus,
    mode,
    thread.contextManager,
  )
    ? d`\n${contextFilesView(thread.contextManager, contextViewCtx(thread), {
        expanded: thread.state.contextFilesExpanded,
        onToggle: () => dispatch({ type: "toggle-context-files-expanded" }),
      })}`
    : d``;

  const sandboxView = thread.sandboxViolationHandler?.getPendingViolations()
    .size
    ? d`\n${thread.sandboxViolationHandler.view()}`
    : d``;
  const compactionHistoryView = renderCompactionHistory(
    thread.core.state.compactionHistory,
    thread.state.compactionViewState,
    dispatch,
  );
  const editedFilesView = editedFilesSummaryView(
    thread.core.state.editedFilesThisTurn,
    thread,
    dispatch,
  );
  const pendingCount = thread.core.state.pendingMessages.length;
  const pendingMessagesView =
    pendingCount > 0
      ? d`\n${thread.core.state.pendingMessages.map((m, index) =>
          renderPendingMessage(m.text, index, thread, dispatch),
        )}`
      : d``;
  const pendingNextMessagesView =
    thread.core.state.pendingNextMessages.length > 0
      ? d`\n${thread.core.state.pendingNextMessages.map((m, index) =>
          renderPendingMessage(
            m.text,
            pendingCount + index,
            thread,
            dispatch,
            "# ⏭️ queued (next stop):\n",
          ),
        )}`
      : d``;

  // Helper to check if a message is composed entirely of auto-generated content

  const renderForkIndicator = (fork: {
    childThreadId: ThreadId;
    atMessageIdx: NativeMessageIdx;
  }) =>
    withBindings(
      withExtmark(d`↳ forked to thread ${fork.childThreadId.slice(-8)}\n`, {
        hl_group: "@comment",
      }),
      {
        "<CR>": () =>
          thread.context.dispatch({
            type: "select-thread-effect",
            id: fork.childThreadId,
          }),
      },
    );

  const forkedToAtIdx = (messageIdx: number) => {
    const forks = thread.state.forkedTo.filter(
      (fork) => fork.atMessageIdx === messageIdx,
    );
    return forks.length > 0
      ? d`${forks.map((fork) => renderForkIndicator(fork))}`
      : d``;
  };

  // Forks whose atMessageIdx is past the last rendered message are appended at
  // the end so they aren't lost.
  const trailingForkedToView =
    thread.state.forkedTo.filter((fork) => fork.atMessageIdx >= messages.length)
      .length > 0
      ? d`\n${thread.state.forkedTo
          .filter((fork) => fork.atMessageIdx >= messages.length)
          .map((fork) => renderForkIndicator(fork))}`
      : d``;
  // (tool results, system reminders, context updates) — used to suppress the
  // "# user:" header for messages that contain no user-authored text.
  const isToolResultOnlyMessage = (msg: ProviderMessage): boolean =>
    msg.role === "user" &&
    msg.content.every(
      (c) =>
        c.type === "tool_result" ||
        c.type === "system_reminder" ||
        c.type === "system_info" ||
        c.type === "context_update" ||
        c.type === "fork_notification",
    );

  // Render messages from provider thread
  const messagesView = messages.map((message, messageIdx) => {
    // Skip user messages that only contain tool results (no system_reminder)
    if (
      message.role === "user" &&
      message.content.every((c) => c.type === "tool_result")
    ) {
      return d``;
    }

    // For user messages composed only of auto-generated content (tool_result,
    // system_reminder, context_update) that include at least one system_reminder,
    // skip the user header and inline the reminder.
    const isToolResultWithReminder =
      message.role === "user" &&
      message.content.every(
        (c) =>
          c.type === "tool_result" ||
          c.type === "system_reminder" ||
          c.type === "system_info" ||
          c.type === "context_update" ||
          c.type === "fork_notification",
      ) &&
      message.content.some(
        (c) => c.type === "system_reminder" || c.type === "fork_notification",
      );

    // Skip "# assistant:" header if this is a continuation of a tool-use turn
    // (i.e., previous message was a tool-result-only user message)
    const prevMessage = messageIdx > 0 ? messages[messageIdx - 1] : undefined;
    const isAssistantContinuation =
      message.role === "assistant" &&
      prevMessage &&
      isToolResultOnlyMessage(prevMessage);

    const showRoleHeader =
      !isToolResultWithReminder && !isAssistantContinuation;
    const isUserBlock = showRoleHeader && message.role === "user";

    const roleHeader = showRoleHeader
      ? withExtmark(d`# ${message.role}:\n`, {
          hl_group: "@markup.heading.1.markdown",
        })
      : d``;

    // Get view state for this message
    const viewState = thread.state.messageViewState[messageIdx];

    // Render context updates for user messages
    const contextUpdateView = viewState?.contextUpdates
      ? renderContextUpdate(
          viewState.contextUpdates,
          thread.contextManager,
          contextViewCtx(thread),
          {
            expandedUpdates: viewState.expandedUpdates ?? {},
            onToggle: (filePath) =>
              dispatch({
                type: "toggle-expand-update",
                messageIdx,
                filePath,
              }),
          },
        )
      : d``;

    const gitUpdateView = renderGitUpdate(viewState?.gitUpdate);

    // Render content blocks. For user messages we render auto-generated meta
    // blocks (system_reminder, system_info) before the user's own text so the
    // user's message stays the most prominent (last) thing on screen, even
    // though the underlying message keeps the user text first for the API.
    const orderedContentIndices = message.content.map((_, idx) => idx);
    if (message.role === "user") {
      orderedContentIndices.sort((a, b) => {
        const isMeta = (c: (typeof message.content)[number]) =>
          c.type === "system_reminder" || c.type === "system_info";
        const aMeta = isMeta(message.content[a]) ? 0 : 1;
        const bMeta = isMeta(message.content[b]) ? 0 : 1;
        if (aMeta !== bMeta) return aMeta - bMeta;
        return a - b;
      });
    }
    const lastContentIdx =
      orderedContentIndices[orderedContentIndices.length - 1];
    const contentView = orderedContentIndices.map((contentIdx) => {
      const content = message.content[contentIdx];
      const isLastBlock = contentIdx === lastContentIdx;
      return renderMessageContent(
        content,
        messageIdx,
        contentIdx,
        thread,
        dispatch,
        message.usage,
        isLastBlock,
      );
    });

    const messageBody = d`\
${roleHeader}\
${gitUpdateView}\
${contextUpdateView}\
${contentView}`;

    const renderedBody = isUserBlock
      ? withExtmark(messageBody, {
          hl_group: "CursorLine",
          hl_eol: true,
        })
      : messageBody;

    return d`${renderedBody}${forkedToAtIdx(messageIdx)}`;
  });

  const streamingBlockView =
    agentStatus.type === "streaming"
      ? d`\n${renderStreamingBlock(thread)}\n`
      : d``;

  const failedSubmit = thread.core.state.failedSubmit;
  const failedSubmitView =
    failedSubmit !== undefined
      ? d`${withExtmark(
          d`${withExtmark(d`# user:\n`, {
            hl_group: "@markup.heading.1.markdown",
          })}${failedSubmit.userMessage}\n`,
          { hl_group: "CursorLine", hl_eol: true },
        )}${withExtmark(d`Error: ${failedSubmit.errorMessage}\n`, {
          hl_group: "ErrorMsg",
        })}`
      : d``;

  return d`\
${titleView}
${systemPromptView}
${toolDefinitionsView}
${compactionHistoryView}
${messagesView}\
${failedSubmitView}\
${streamingBlockView}\
${contextManagerView}\
${sandboxView}\
${pendingMessagesView}${pendingNextMessagesView}\
${trailingForkedToView}\
${editedFilesView}
${statusView}`;
};

/** Render a single content block from a message */
function renderMessageContent(
  content: ProviderMessageContent,
  messageIdx: number,
  contentIdx: number,
  thread: Thread,
  dispatch: Dispatch<Msg>,
  messageUsage: Usage | undefined,
  isLastBlock: boolean,
): VDOMNode {
  const inner = renderMessageContentBlock(
    content,
    messageIdx,
    contentIdx,
    thread,
    dispatch,
    messageUsage,
    isLastBlock,
  );
  // Wrap the inner block in a fresh `d` node so that its own bindings (e.g.
  // <CR> to expand a thinking block) live on a child node and continue to
  // take precedence per getBindings' "most specific wins" traversal. The F
  // binding lives on the outer wrapper.
  return withBindings(d`${inner}`, {
    F: (ctx) =>
      dispatch({
        type: "fork-message",
        nativeMessageIdx: content.nativeMessageIdx,
        ...(ctx?.selection ? { prepopulate: ctx.selection } : {}),
      }),
  });
}

function renderMessageContentBlock(
  content: ProviderMessageContent,
  messageIdx: number,
  contentIdx: number,
  thread: Thread,
  dispatch: Dispatch<Msg>,
  messageUsage: Usage | undefined,
  isLastBlock: boolean,
): VDOMNode {
  switch (content.type) {
    case "text":
      return d`${content.text}\n`;

    case "thinking": {
      const viewState = thread.state.messageViewState[messageIdx];
      const isExpanded = viewState?.expandedContent?.[contentIdx] || false;

      if (isExpanded) {
        return withBindings(
          withExtmark(d`💭 [Thinking]\n${content.thinking}\n`, {
            hl_group: "@comment",
          }),
          {
            "=": () => {
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              });
            },
          },
        );
      } else {
        return withBindings(
          withExtmark(d`💭 [Thinking]\n`, { hl_group: "@comment" }),
          {
            "=": () =>
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              }),
          },
        );
      }
    }

    case "redacted_thinking":
      return withExtmark(d`💭 [Redacted Thinking]\n`, { hl_group: "@comment" });

    case "system_reminder": {
      const viewState = thread.state.messageViewState[messageIdx];
      const isExpanded = viewState?.expandedContent?.[contentIdx] || false;

      if (isExpanded) {
        return withBindings(
          withExtmark(d`📋 [System Reminder]\n${content.text}\n`, {
            hl_group: "@comment",
          }),
          {
            "=": () => {
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              });
            },
          },
        );
      } else {
        // Render inline (no newline) so checkpoint can follow on same line
        return withBindings(
          withExtmark(d`📋 [System Reminder]\n`, { hl_group: "@comment" }),
          {
            "=": () =>
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              }),
          },
        );
      }
    }

    case "system_info": {
      const viewState = thread.state.messageViewState[messageIdx];
      const isExpanded = viewState?.expandedContent?.[contentIdx] || false;

      if (isExpanded) {
        return withBindings(
          withExtmark(d`🖥️  [System Info]\n${content.text}\n`, {
            hl_group: "@comment",
          }),
          {
            "=": () =>
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              }),
          },
        );
      } else {
        return withBindings(
          withExtmark(d`🖥️  [System Info]\n`, { hl_group: "@comment" }),
          {
            "=": () =>
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              }),
          },
        );
      }
    }

    case "tool_use": {
      if (content.request.status === "error") {
        return d`Malformed request: ${content.request.error}\n`;
      }

      const request = content.request.value;
      const toolViewState = thread.state.toolViewState[request.id];

      const displayContext = {
        cwd: thread.context.cwd,
        homeDir: thread.context.homeDir,
      };
      const renderContext = {
        getDisplayWidth: thread.context.getDisplayWidth,
        nvim: thread.context.nvim,
        cwd: thread.context.cwd,
        homeDir: thread.context.homeDir,
        options: thread.context.options,
        dispatch: thread.context.dispatch,
        threadDispatch: dispatch,
        chat: thread.context.chat,
      };

      // Check if tool is active (still running)
      const activeEntry =
        thread.core.state.mode.type === "tool_use" &&
        thread.core.state.mode.activeTools.get(request.id);

      const isActive = !!activeEntry;
      const abortBinding = isActive
        ? { t: () => activeEntry?.handle.abort() }
        : {};

      // A tool is "in flight" while its input is still streaming in or while it
      // is executing - i.e. until a result has been recorded. Some tools (edl)
      // show a streaming preview only while in flight.
      const completedResult = isActive
        ? undefined
        : findToolResult(thread, request.id);
      const inFlight = isActive || !completedResult;

      // Show usage in details if this is the last block in the message
      const usageInDetails =
        isLastBlock && messageUsage ? d`\n${renderUsage(messageUsage)}` : d``;

      // Section 1: Tool summary (always shown)
      const summaryView = withBindings(
        d`${renderToolSummary(request, displayContext)}`,
        {
          "=": () =>
            dispatch({
              type: "toggle-tool-input-summary",
              toolRequestId: request.id,
            }),
          ...abortBinding,
        },
      );

      // Section 2: Input summary expansion (pretty-printed if the tool
      // provides one, otherwise a raw JSON.stringify of the input)
      const inputSummaryContent =
        renderToolInputSummaryExpansion(request) ??
        d`${JSON.stringify(request.input, null, 2)}`;
      const inputSummaryView = toolViewState?.inputSummaryExpanded
        ? withBindings(d`\n${inputSummaryContent}`, {
            "=": () =>
              dispatch({
                type: "toggle-tool-input-summary",
                toolRequestId: request.id,
              }),
          })
        : d``;

      // Section 3: Tool input (rich preview / detail)
      const inputContent = renderToolInput(
        request,
        displayContext,
        toolViewState?.inputExpanded || false,
        inFlight,
      );
      const inputView = inputContent
        ? withBindings(d`\n${inputContent}`, {
            "=": () =>
              dispatch({
                type: "toggle-tool-input",
                toolRequestId: request.id,
              }),
            ...abortBinding,
          })
        : d``;

      // Section 4: Progress (in-flight only)
      let progressView: VDOMNode = d``;
      if (activeEntry) {
        const progressContent = renderToolProgress(
          activeEntry.request,
          activeEntry.progress,
          renderContext,
          toolViewState?.progressExpanded || false,
          toolViewState || {
            inputSummaryExpanded: false,
            inputExpanded: false,
            progressExpanded: false,
            resultSummaryExpanded: false,
            resultExpanded: false,
          },
          request.id,
        );
        if (progressContent) {
          progressView = withBindings(d`\n${progressContent}`, {
            "=": () =>
              dispatch({
                type: "toggle-tool-progress",
                toolRequestId: request.id,
              }),
            ...abortBinding,
          });
        }
      }

      // Sections 5-7: Result (completed only)
      let resultSummaryView: VDOMNode = d``;
      let resultSummaryExpansionView: VDOMNode = d``;
      let resultView: VDOMNode = d``;

      if (!activeEntry) {
        const toolResult = completedResult;
        if (!toolResult) {
          return d`⚠️ tool result for ${request.id} not found\n`;
        }

        const completedInfo: CompletedToolInfo = {
          request: request,
          result: toolResult,
          structuredResult:
            toolResult.result.status === "ok"
              ? toolResult.result.structuredResult
              : { toolName: request.toolName as ToolName },
        };

        // Section 5: Result summary. get_files renders its own interactive
        // per-file result in Section 7, so it opts out of the generic summary.
        const rendersOwnResult = request.toolName === "get_files";

        if (!rendersOwnResult) {
          resultSummaryView = withBindings(
            d`\n${renderToolResultSummary(completedInfo, displayContext)}`,
            {
              "=": () =>
                dispatch({
                  type: "toggle-tool-result-summary",
                  toolRequestId: request.id,
                }),
            },
          );
        }

        // Section 6: Result summary expansion (pretty-printed if the tool
        // provides one, otherwise a raw JSON.stringify of the result)
        if (!rendersOwnResult && toolViewState?.resultSummaryExpanded) {
          const prettyResult = renderToolResultSummaryExpansion(completedInfo);
          const resultContent =
            prettyResult ??
            (toolResult.result.status === "ok"
              ? d`${JSON.stringify(toolResult.result.value, null, 2)}`
              : d`${JSON.stringify({ error: toolResult.result.error }, null, 2)}`);
          resultSummaryExpansionView = withBindings(d`\n${resultContent}`, {
            "=": () =>
              dispatch({
                type: "toggle-tool-result-summary",
                toolRequestId: request.id,
              }),
          });
        }

        // Section 7: Result detail (each tool owns its own bindings)
        const effectiveToolViewState: ToolViewState = toolViewState || {
          inputSummaryExpanded: false,
          inputExpanded: false,
          progressExpanded: false,
          resultSummaryExpanded: false,
          resultExpanded: false,
        };
        const resultContent = renderToolResult(
          completedInfo,
          renderContext,
          effectiveToolViewState,
          request.id,
        );
        if (resultContent) {
          resultView = d`\n${resultContent}`;
        }
      }

      return d`${summaryView}${inputSummaryView}${inputView}${progressView}${resultSummaryView}${resultSummaryExpansionView}${resultView}${usageInDetails}\n`;
    }

    case "tool_result":
      // Tool results are rendered with their corresponding tool_use
      return d``;

    case "image":
      return d``;

    case "document":
      return d`[Document${content.title ? `: ${content.title}` : ""}]\n`;

    case "server_tool_use":
      return d`🔍 Searching ${withExtmark(d`${content.input.query}`, { hl_group: "@string" })}...\n`;

    case "web_search_tool_result": {
      const viewState = thread.state.messageViewState[messageIdx];
      const isExpanded = viewState?.expandedContent?.[contentIdx] || false;

      if (
        "type" in content.content &&
        content.content.type === "web_search_tool_result_error"
      ) {
        return d`🌐 Search error: ${withExtmark(d`${content.content.error_code}`, { hl_group: "ErrorMsg" })}\n`;
      }
      if (Array.isArray(content.content)) {
        const searchResults = content.content.filter(
          (
            r,
          ): r is Extract<
            (typeof content.content)[number],
            { type: "web_search_result" }
          > => r.type === "web_search_result",
        );
        if (isExpanded) {
          const results = searchResults.map(
            (r) =>
              d`  [${r.title}](${r.url})${r.page_age ? ` (${r.page_age})` : ""}\n`,
          );
          return withBindings(d`🌐 Search results\n${results}\n`, {
            "=": () =>
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              }),
          });
        }
        return withBindings(
          d`🌐 ${searchResults.length.toString()} search result${searchResults.length === 1 ? "" : "s"}\n`,
          {
            "=": () =>
              dispatch({
                type: "toggle-expand-content",
                messageIdx,
                contentIdx,
              }),
          },
        );
      }
      return d`🌐 Search results\n`;
    }

    case "fork_notification": {
      const viewState = thread.state.messageViewState[messageIdx];
      const parentThreadId = viewState?.forkedFrom;
      const shortId = parentThreadId ? parentThreadId.slice(-8) : "unknown";
      const line = withExtmark(d`↰ forked from ${shortId}\n`, {
        hl_group: "@comment",
      });
      if (!parentThreadId) {
        return line;
      }
      return withBindings(line, {
        "<CR>": () =>
          thread.context.dispatch({
            type: "select-thread-effect",
            id: parentThreadId,
          }),
      });
    }

    case "context_update":
      // Context updates are rendered via thread.state.messageViewState
      return d``;

    default:
      return d`[Unknown content type]\n`;
  }
}

/** Find the tool result for a given tool request ID using the cached map */
export function findToolResult(
  thread: Thread,
  toolRequestId: ToolRequestId,
): ProviderToolResult | undefined {
  return thread.state.toolResultMap.get(toolRequestId);
}

function renderStreamingBlock(thread: Thread): string | VDOMNode {
  const state = thread.agent.getState();
  const block = state.streamingBlock;
  if (!block) return d``;

  switch (block.type) {
    case "text":
      return d`${block.text}`;
    case "thinking": {
      const lastLine = block.thinking.slice(
        block.thinking.lastIndexOf("\n") + 1,
      );
      return withExtmark(d`\n💭 [Thinking] ${lastLine}`, {
        hl_group: "@comment",
      });
    }
    case "tool_use": {
      return renderStreamdedTool(block);
    }
  }
}

export const LOGO = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "logo.txt"),
  "utf-8",
);

const MESSAGE_ANIMATION = ["⠁", "⠂", "⠄", "⠂"];
