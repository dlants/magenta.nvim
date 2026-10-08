import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DisplayBufferText, SystemPrompt } from "@magenta/server";
import {
  type CompactionRunState,
  type CompletedToolInfo,
  type ContentBlockIdx,
  compactionRunChunkIndex,
  compactionRunThreadIds,
  displayPath,
  type EditedFileGroup,
  formatToolSpec,
  formatToolSpecs,
  isSelectionAnchor,
  type MessageIdx,
  type NativeMessageIdx,
  type ProtocolActivity,
  type ProtocolRunState,
  type ProtocolSubmissionResult,
  type ProtocolThreadState,
  type ProviderToolSpec,
  renderPending,
  type ThreadId,
  type ToolRequestId,
  type YieldState,
} from "@magenta/server";
import { renderPendingApprovals } from "../capabilities/render-pending-approvals.ts";
import {
  type ContextFilesData,
  type ContextViewContext,
  contextFilesView,
  renderContextUpdate,
  renderGitUpdate,
} from "../context/context-manager.ts";
import { notify } from "../nvim/nvim.ts";
import type {
  ProviderMessage,
  ProviderMessageContent,
  StopReason,
  ToolResultInput,
  Usage,
} from "../providers/provider.ts";
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
import { spinnerFrame } from "../spinner.ts";
import { isRangeWithinNode } from "../tea/bindings.ts";
import type { Dispatch } from "../tea/tea.ts";
import {
  d,
  type NodeHighlight,
  type VDOMNode,
  type View,
  withBindings,
  withExtmark,
  withHighlights,
} from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { formatTokens } from "../utils/tokens.ts";
import { reflectionTree } from "./reflections-overview.ts";
import type { Msg, NvimThread, ToolViewState } from "./thread.ts";

function contextViewCtx(thread: NvimThread): ContextViewContext {
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
const shortErrorMessage = (error: { message: string }): string => {
  const msg = error.message.split("\n")[0].trim();
  return msg.length > 80 ? `${msg.slice(0, 77)}...` : msg;
};

/**
 * Helper function to render the status message
 * Composes agent status with thread mode for complete display
 */
/** The compaction in flight, plus the way into the chunk thread doing the
 * work — the status line is a navigation target, not just a spinner. */
export type RunningCompaction = {
  run: Extract<CompactionRunState, { type: "running" }>;
  onSelectChunk: (threadId: ThreadId) => void;
};

export function renderYield(
  yielded: Pick<YieldState, "value" | "resultPrefix">,
): string {
  const body =
    Object.keys(yielded.value).length === 1 &&
    typeof yielded.value.result === "string"
      ? yielded.value.result
      : JSON.stringify(yielded.value);
  return yielded.resultPrefix ? `${yielded.resultPrefix}\n\n${body}` : body;
}

export const renderStatus = (
  loopState: ProtocolRunState,
  latestUsage: Usage | undefined,
  compaction: RunningCompaction | undefined,
  requestTick: () => void,
): VDOMNode => {
  if (loopState.type === "yielded") {
    return d`↗️ yielded to parent: ${renderYield(loopState)}`;
  }
  if (compaction) {
    const { run, onSelectChunk } = compaction;
    const line = d`📦 Compacting thread... (chunk ${String(compactionRunChunkIndex(run) + 1)} / ${String(run.totalChunks)})`;
    return withBindings(line, {
      "<CR>": () => onSelectChunk(run.activeThreadId),
    });
  }

  // Then render based on what the loop is doing
  switch (loopState.type) {
    case "running": {
      if (loopState.aborting) return d`Aborting...`;
      const activity = loopState.activity;
      switch (activity.type) {
        case "preparing":
          return d`Preparing...`;
        case "running_tools":
          return d`Executing tools...`;
        case "streaming":
          return renderStreaming(activity, requestTick);
        default:
          return assertUnreachable(activity);
      }
    }
    case "idle":
    case "destroyed":
      return renderSubmissionResult(loopState.lastResult, latestUsage);
    default:
      assertUnreachable(loopState);
  }
};
function renderStreaming(
  activity: Extract<ProtocolActivity, { type: "streaming" }>,
  requestTick: () => void,
): VDOMNode {
  requestTick();
  if (activity.retry) {
    const secsLeft = Math.max(
      1,
      Math.ceil((activity.retry.nextRetryAt - Date.now()) / 1000),
    );
    const reason = shortErrorMessage(activity.retry.error);
    return d`⏳ Retrying in ${String(secsLeft)}s (attempt ${String(activity.retry.attempt)}) — ${reason}`;
  }
  const waitedMs = Date.now() - activity.lastEventTime;
  if (waitedMs > 3000) {
    const waitedSecs = Math.floor(waitedMs / 1000);
    return d`Streaming response ${spinnerFrame(new Date(activity.startedAt))} (waiting ${String(waitedSecs)}s)`;
  }
  return d`Streaming response ${spinnerFrame(new Date(activity.startedAt))}`;
}

/** How the last submission ended, as the view sees it: a suspension is a
 * handoff, never rendered. */
type RenderedResult = ProtocolSubmissionResult | undefined;
function renderSubmissionResult(
  result: RenderedResult,
  usage: Usage | undefined,
): VDOMNode {
  if (!result) {
    return renderStopReason("end_turn", usage);
  }
  switch (result.type) {
    case "completed":
      return renderStopReason(result.stopReason, usage);
    case "empty":
    case "yielded":
      return renderStopReason("end_turn", usage);
    case "aborted":
      return d`[ABORTED] ${usage ? d` ${renderUsage(usage)}` : d``} `;
    case "failed":
      return d`Error ${result.error.message}`;
    default:
      return assertUnreachable(result);
  }
}

function renderStopReason(
  stopReason: StopReason,
  usage: Usage | undefined,
): VDOMNode {
  const usageView = usage ? d` ${renderUsage(usage)}` : d``;
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
const shouldShowContextFiles = (state: ProtocolThreadState): boolean => {
  return state.run.type !== "running" && state.contextFiles.length > 0;
};

function contextFilesData(thread: NvimThread): ContextFilesData {
  const state = thread.threadState;
  return {
    files: state.contextFiles,
    pending: state.pendingContextUpdates,
    remove: (absFilePath) =>
      thread.context.dispatch({
        type: "thread-msg",
        id: thread.id,
        msg: { type: "remove-context-file", absFilePath },
      }),
  };
}

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
  specs: ReadonlyArray<ProviderToolSpec>,
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

/** Past runs, most recent last. Each chunk of a run is a real thread, so an
 * expanded run is a list of threads the user can walk into rather than an
 * inlined transcript. */
function renderCompactionHistory(
  runs: ReadonlyArray<CompactionRunState>,
  thread: NvimThread,
  viewState: NvimThread["state"]["compactionViewState"],
  dispatch: Dispatch<Msg>,
): VDOMNode {
  const history = runs.filter((run) => run.type !== "running");
  if (history.length === 0) return d``;
  return d`${history.map((run, recordIdx) => {
    const isExpanded = viewState[run.id]?.expanded || false;
    const status =
      run.type === "done"
        ? `summary: ${run.summary.length.toString()} chars`
        : run.type === "aborted"
          ? "aborted"
          : `⚠️ ${run.message}`;
    const chunkThreadIds = compactionRunThreadIds(run);
    const chunkCount = chunkThreadIds.length;
    const header = withBindings(
      withExtmark(
        d`📦 [Compaction ${(recordIdx + 1).toString()} — ${chunkCount.toString()} chunk${chunkCount === 1 ? "" : "s"}, ${status}]\n`,
        { hl_group: "@comment" },
      ),
      {
        "=": () =>
          dispatch({ type: "toggle-compaction-record", runId: run.id }),
      },
    );
    if (!isExpanded) return header;
    const chunkViews = chunkThreadIds.map(
      (threadId, chunkIdx) =>
        d`${renderChunkThreadRow(thread, threadId, chunkIdx, chunkCount)}`,
    );
    const summaryView =
      run.type === "done"
        ? d`  📋 Final Summary:\n${withExtmark(d`${run.summary}\n`, { hl_group: "@comment" })}`
        : d`  ⚠️ Compaction did not produce a summary\n`;
    return d`${header}${chunkViews}${summaryView}`;
  })}`;
}
function runningCompaction(thread: NvimThread): RunningCompaction | undefined {
  const run = thread.threadState.compaction.runs.findLast(
    (r): r is RunningCompaction["run"] => r.type === "running",
  );
  if (!run) return undefined;
  return {
    run,
    onSelectChunk: (threadId) =>
      thread.context.dispatch({ type: "select-thread-effect", id: threadId }),
  };
}

/** One chunk thread, selectable — the transcript lives in that thread now. */
function renderChunkThreadRow(
  thread: NvimThread,
  threadId: ThreadId,
  chunkIdx: number,
  totalChunks: number,
): VDOMNode {
  return withBindings(
    withExtmark(
      d`  📄 [chunk ${(chunkIdx + 1).toString()} of ${totalChunks.toString()}]\n`,
      { hl_group: "@comment" },
    ),
    {
      "<CR>": () =>
        thread.context.dispatch({ type: "select-thread-effect", id: threadId }),
    },
  );
}
function editedFilesSummaryView(
  group: EditedFileGroup,
  thread: NvimThread,
  dispatch: Dispatch<Msg>,
): VDOMNode {
  const editedFiles = group.files;
  if (editedFiles.length === 0) return d``;

  const { cwd, homeDir } = thread.context;
  return d`\n${withExtmark(d`Files edited:\n`, { hl_group: "@comment" })}${editedFiles.map(
    ({ path: filePath, snapshot, content }) => {
      const display = displayPath(cwd, filePath, homeDir);
      const created = snapshot === "";
      const label = created ? "created" : "modified";
      const expanded =
        thread.state.editedFilesExpanded[`${group.id}:${filePath}`];
      const marker = expanded ? "▼" : "▶";
      const row = withBindings(d`  ${marker} ${label} ${display}\n`, {
        "=": () =>
          dispatch({
            type: "toggle-edited-file-expanded",
            groupId: group.id,
            filePath,
          }),
        "<CR>": () =>
          created
            ? dispatch({ type: "open-edit-file", filePath })
            : dispatch({
                type: "open-edit-file-diff",
                filePath,
                snapshot,
                content,
              }),
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
  thread: NvimThread,
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
  thread: NvimThread;
  dispatch: Dispatch<Msg>;
}> = ({ thread, dispatch }) => {
  const state = thread.threadState;
  const threadType = state.threadType;
  const titlePrefix = threadType === "docker_root" ? "🐳 " : "";
  const archiveLink = withBindings(d`[Archive]`, {
    "<CR>": () =>
      thread.context.dispatch({
        type: "select-archived-thread-effect",
        id: thread.id,
      }),
  });
  const titleView = state.title
    ? d`# ${titlePrefix}${state.title} ${archiveLink}`
    : d`# ${titlePrefix}[ Untitled ] ${archiveLink}`;

  const systemPromptView = renderSystemPrompt(
    state.systemPrompt,
    thread.state.showSystemPrompt,
    dispatch,
  );

  const toolDefinitionsView = renderToolDefinitions(
    state.toolSpecs,
    thread.state.showToolDefinitions,
    thread.state.expandedToolDefinitions,
    dispatch,
  );

  const messages = state.messages;
  const loopState = state.run;

  // Show logo when empty and not busy
  const isIdle = loopState.type !== "running";
  if (messages.length === 0 && isIdle && thread.submission?.type !== "failed") {
    return d`\
${titleView}
${systemPromptView}
${toolDefinitionsView}

${LOGO}

magenta is for agentic flow

${contextFilesView(contextFilesData(thread), contextViewCtx(thread), {
  expanded: thread.state.contextFilesExpanded,
  onToggle: () => dispatch({ type: "toggle-context-files-expanded" }),
})}`;
  }

  const statusView = renderStatus(
    loopState,
    state.latestUsage,
    runningCompaction(thread),
    thread.requestAnimationTick,
  );

  const fileSupervisorView = shouldShowContextFiles(state)
    ? d`\n${contextFilesView(contextFilesData(thread), contextViewCtx(thread), {
        expanded: thread.state.contextFilesExpanded,
        onToggle: () => dispatch({ type: "toggle-context-files-expanded" }),
      })}`
    : d``;

  const sandboxView =
    renderPendingApprovals(
      thread.context.chat.session,
      thread.context.server,
      thread.id,
    ) ?? d``;
  const compactionHistoryView = renderCompactionHistory(
    state.compaction.runs,
    thread,
    thread.state.compactionViewState,
    dispatch,
  );
  const editedGroups = state.editedFileGroups.filter(
    (group) =>
      group.endNativeMessageIdx !== undefined && group.files.length > 0,
  );
  const editedFilesAtMessage = new Map<number, EditedFileGroup[]>();
  for (const group of editedGroups) {
    // Provider conversion can merge or hide native items. Place the boundary
    // after the last display message beginning at or before the native stop.
    let at = -1;
    for (let i = 0; i < messages.length; i++) {
      if (
        messages[i].content.some(
          (block) => block.nativeMessageIdx <= group.endNativeMessageIdx!,
        )
      )
        at = i;
    }
    const groups = editedFilesAtMessage.get(at) ?? [];
    groups.push(group);
    editedFilesAtMessage.set(at, groups);
  }
  const editsAt = (messageIdx: number) =>
    d`${(editedFilesAtMessage.get(messageIdx) ?? []).map((group) =>
      editedFilesSummaryView(group, thread, dispatch),
    )}`;
  const { async: pendingAsync, next: pendingNext } = state.queued;
  const pendingCount = pendingAsync.length;
  const pendingMessagesView =
    pendingCount > 0
      ? d`\n${pendingAsync.map((q, index) =>
          renderPendingMessage(renderPending(q), index, thread, dispatch),
        )}`
      : d``;
  const pendingNextMessagesView =
    pendingNext.length > 0
      ? d`\n${pendingNext.map((q, index) =>
          renderPendingMessage(
            renderPending(q),
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

  const session = thread.context.chat.session;
  const forkedTo = session.listDerived(thread.id, "fork").map((d) => ({
    childThreadId: d.threadId,
    atMessageIdx: d.origin.nativeMessageIdx,
  }));
  const reflections = session.listDerived(thread.id, "reflect");
  const reflectionsFor = (
    messageIdx: MessageIdx,
    contentIdx: ContentBlockIdx,
  ): NodeHighlight[] =>
    reflections
      .filter(
        ({ origin }) =>
          isSelectionAnchor(origin.anchor) &&
          origin.anchor.messageIdx === messageIdx &&
          origin.anchor.contentIdx === contentIdx,
      )
      .flatMap(({ threadId, origin }) =>
        isSelectionAnchor(origin.anchor)
          ? [
              reflectionHighlight(
                thread,
                threadId,
                origin.anchor.reflectionText,
              ),
            ]
          : [],
      );
  const messageReflectionsAt = (messageIdx: number) => {
    const ids = reflections
      .filter(
        ({ origin }) =>
          !isSelectionAnchor(origin.anchor) &&
          origin.anchor.messageIdx === messageIdx,
      )
      .map(({ threadId }) => threadId);
    if (ids.length === 0) return d``;
    const [only] = ids;
    return withBindings(
      withExtmark(
        d`↳ ${String(ids.length)} reflection${ids.length === 1 ? "" : "s"}\n`,
        { hl_group: "@comment" },
      ),
      {
        "<CR>": () =>
          thread.context.dispatch(
            ids.length === 1 && only
              ? { type: "select-thread-effect", id: only }
              : { type: "show-reflections-overview", threadId: thread.id },
          ),
      },
    );
  };
  const forkedToAtIdx = (messageIdx: number) => {
    const forks = forkedTo.filter((fork) => fork.atMessageIdx === messageIdx);
    return forks.length > 0
      ? d`${forks.map((fork) => renderForkIndicator(fork))}`
      : d``;
  };

  // Forks whose atMessageIdx is past the last rendered message are appended at
  // the end so they aren't lost.
  const trailingForkedToView =
    forkedTo.filter((fork) => fork.atMessageIdx >= messages.length).length > 0
      ? d`\n${forkedTo
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

  // Context injections are recorded against the native message they landed in.
  // One native item can surface as several provider messages, so the delivery
  // renders once, on the first of them.
  const deliveryOwner = new Map<NativeMessageIdx, number>();
  messages.forEach((message, messageIdx) => {
    const nativeIdx = message.content[0]?.nativeMessageIdx;
    if (nativeIdx === undefined || deliveryOwner.has(nativeIdx)) return;
    deliveryOwner.set(nativeIdx, messageIdx);
  });
  const deliveryAt = (message: ProviderMessage, messageIdx: number) => {
    const nativeIdx = message.content[0]?.nativeMessageIdx;
    if (nativeIdx === undefined) return undefined;
    if (deliveryOwner.get(nativeIdx) !== messageIdx) return undefined;
    return state.contextDeliveries[nativeIdx];
  };
  // Render messages from provider thread
  const messagesView = messages.map((message, messageIdx) => {
    // Skip user messages that only contain tool results (no system_reminder)
    if (
      message.role === "user" &&
      message.content.every((c) => c.type === "tool_result")
    ) {
      return editsAt(messageIdx);
    }

    // User messages composed only of auto-generated content (tool_result,
    // system_reminder, system_info, context_update, fork_notification) are not
    // authored by the user, so we skip the user header and inline the content.
    const isAutoGeneratedUserMessage =
      message.role === "user" &&
      message.content.length > 0 &&
      message.content.every(
        (c) =>
          c.type === "tool_result" ||
          c.type === "system_reminder" ||
          c.type === "system_info" ||
          c.type === "context_update" ||
          c.type === "fork_notification",
      );

    // Skip "# assistant:" header if this is a continuation of a tool-use turn
    // (i.e., previous message was a tool-result-only user message)
    const prevMessage = messageIdx > 0 ? messages[messageIdx - 1] : undefined;
    const isAssistantContinuation =
      message.role === "assistant" &&
      prevMessage &&
      isToolResultOnlyMessage(prevMessage);

    const showRoleHeader =
      !isAutoGeneratedUserMessage && !isAssistantContinuation;
    const isUserBlock = showRoleHeader && message.role === "user";

    const roleHeader = showRoleHeader
      ? withExtmark(d`# ${message.role}:\n`, {
          hl_group: "@markup.heading.1.markdown",
        })
      : d``;

    // Get view state for this message
    const viewState = thread.state.messageViewState[messageIdx];

    // Render context updates for user messages
    const delivery = deliveryAt(message, messageIdx);
    const contextUpdateView = delivery?.files
      ? renderContextUpdate(
          delivery.files,
          state.contextFiles,
          contextViewCtx(thread),
          {
            expandedUpdates: viewState?.expandedUpdates ?? {},
            onToggle: (filePath) =>
              dispatch({
                type: "toggle-expand-update",
                messageIdx,
                filePath,
              }),
          },
        )
      : d``;

    const gitUpdateView = renderGitUpdate(delivery?.git);

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
        messageIdx as MessageIdx,
        contentIdx as ContentBlockIdx,
        thread,
        dispatch,
        message.usage,
        isLastBlock,
        reflectionsFor(messageIdx as MessageIdx, contentIdx as ContentBlockIdx),
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

    return d`${renderedBody}${editsAt(messageIdx)}${forkedToAtIdx(messageIdx)}${messageReflectionsAt(messageIdx)}`;
  });

  const streamingBlockView = streamingBlock(loopState)
    ? d`\n${renderStreamingBlock(thread)}\n`
    : d``;

  const failedSubmit =
    thread.submission?.type === "failed" ? thread.submission : undefined;
  const failedSubmitView =
    failedSubmit !== undefined
      ? d`${withExtmark(
          d`${withExtmark(d`# user:\n`, {
            hl_group: "@markup.heading.1.markdown",
          })}${failedSubmit.text}\n`,
          { hl_group: "CursorLine", hl_eol: true },
        )}${withExtmark(d`Error: ${failedSubmit.error.message}\n`, {
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
${fileSupervisorView}\
${sandboxView}\
${pendingMessagesView}${pendingNextMessagesView}\
${trailingForkedToView}\
${editsAt(-1)}
${statusView}`;
};

/** Render a single content block from a message */
function renderMessageContent(
  content: ProviderMessageContent,
  messageIdx: MessageIdx,
  contentIdx: ContentBlockIdx,
  thread: NvimThread,
  dispatch: Dispatch<Msg>,
  messageUsage: Usage | undefined,
  isLastBlock: boolean,
  highlights: NodeHighlight[],
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
  const wrapper = withBindings(d`${inner}`, {
    F: (ctx) =>
      dispatch({
        type: "fork-message",
        nativeMessageIdx: content.nativeMessageIdx,
        ...(ctx.selection ? { prepopulate: ctx.selection.lines } : {}),
      }),
    r: (ctx) => {
      const range = ctx.selection?.range;
      if (!ctx.selection) {
        dispatch({ type: "reflect-selection" });
        return;
      }
      if (!range) return;
      if (!isRangeWithinNode(range, ctx.node)) {
        notify(
          thread.context.nvim,
          "Reflection selections must lie within a single content block.",
        ).catch(() => {});
        return;
      }
      dispatch({
        type: "reflect-selection",
        anchor: {
          messageIdx,
          contentIdx,
          reflectionText: range.text,
        },
      });
    },
  });
  return withHighlights(wrapper, highlights);
}

function reflectionLabel(thread: NvimThread, childId: ThreadId): string {
  const record = thread.context.chat.session.getThread(childId);
  if (record?.state !== "ready") return record?.state ?? "missing";
  if (record.run.type === "running") return "streaming…";
  if (record.title) return record.title;
  const child = thread.context.chat.threadWrappers[childId];
  const n =
    child?.state === "initialized"
      ? child.thread.threadState.messages.length
      : 0;
  return `${n} message${n === 1 ? "" : "s"}`;
}

function reflectionHighlight(
  thread: NvimThread,
  childId: ThreadId,
  reflectionText: DisplayBufferText,
): NodeHighlight {
  const label = reflectionLabel(thread, childId);
  const quoted =
    reflectionText.length > 40
      ? `${reflectionText.slice(0, 40).replace(/\n/g, " ")}…`
      : reflectionText.replace(/\n/g, " ");
  return {
    id: childId,
    text: reflectionText,
    extmarkOptions: {
      hl_group:
        thread.context.chat.getActiveReflectionId() === childId
          ? "MagentaReflectActive"
          : "MagentaReflect",
    },
    fallback: {
      virt_lines: [[[`  reflection → ${quoted} (${label})`, "Comment"]]],
    },
    rowLabel: (ids) => {
      const session = thread.context.chat.session;
      const sub = ids.reduce(
        (n, id) => n + reflectionTree(session, id as ThreadId).length,
        0,
      );
      const plural = (n: number, word: string) =>
        `${n} ${word}${n === 1 ? "" : "s"}`;
      const suffix = sub ? ` (${plural(sub, "sub-reflection")})` : "";
      return [
        [[`  ↳ ${plural(ids.length, "reflection")}${suffix}`, "Comment"]],
      ];
    },
    bindings: {
      // Until the two-column layout lands, showing a reflection replaces the
      // source in the single sidebar column.
      r: () =>
        thread.context.dispatch({ type: "select-thread-effect", id: childId }),
    },
  };
}

function renderMessageContentBlock(
  content: ProviderMessageContent,
  messageIdx: number,
  contentIdx: number,
  thread: NvimThread,
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
        requestTick: thread.requestAnimationTick,
        nvim: thread.context.nvim,
        cwd: thread.context.cwd,
        homeDir: thread.context.homeDir,
        options: thread.context.options,
        dispatch: thread.context.dispatch,
        threadDispatch: dispatch,
        chat: thread.context.chat,
      };

      // Check if tool is active (still running)
      const toolState = thread.threadState.tools[request.id];
      const activeEntry =
        toolState?.status === "running" ? toolState : undefined;

      const isActive = !!activeEntry;
      const abortBinding = isActive
        ? {
            t: () =>
              dispatch({ type: "abort-tool", toolRequestId: request.id }),
          }
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
          request: toolState?.request ?? request,
          result: toolResult,
          structuredResult:
            toolState?.status === "done"
              ? toolState.structuredResult
              : undefined,
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

    case "thread_context": {
      const viewState = thread.state.messageViewState[messageIdx];
      const isExpanded = viewState?.expandedContent?.[contentIdx] || false;
      const toggle = {
        "=": () =>
          dispatch({
            type: "toggle-expand-content",
            messageIdx,
            contentIdx,
          }),
      };
      return withBindings(
        isExpanded
          ? d`${withExtmark(d`[thread context]`, { hl_group: "@comment" })}\n${content.text}\n\n`
          : withExtmark(d`[thread context]\n\n`, { hl_group: "@comment" }),
        toggle,
      );
    }

    case "fork_notification": {
      const origin = thread.context.chat.session.getOrigin(thread.id);
      const parentThreadId =
        origin?.type === "fork" ? origin.sourceThreadId : undefined;
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
      // Rendered via thread.state.messageViewState
      return d``;

    default:
      return d`[Unknown content type]\n`;
  }
}

/** Tool results in the history, indexed once per delivered message list. */
const historyToolResults = new WeakMap<
  ReadonlyArray<ProviderMessage>,
  Map<ToolRequestId, ToolResultInput>
>();

/** A tool's result from thread state, falling back to the history for tools
 * this thread did not run itself (e.g. carried over by a fork). */
export function findToolResult(
  thread: NvimThread,
  toolRequestId: ToolRequestId,
): ToolResultInput | undefined {
  const tool = thread.threadState.tools[toolRequestId];
  if (tool?.status === "done") return tool.result;
  const messages = thread.threadState.messages;
  let results = historyToolResults.get(messages);
  if (!results) {
    results = new Map();
    for (const message of messages) {
      if (message.role !== "user") continue;
      for (const content of message.content) {
        if (content.type === "tool_result") results.set(content.id, content);
      }
    }
    historyToolResults.set(messages, results);
  }
  return results.get(toolRequestId);
}

function streamingBlock(run: ProtocolRunState) {
  return run.type === "running" && run.activity.type === "streaming"
    ? run.activity.block
    : undefined;
}

function renderStreamingBlock(thread: NvimThread): string | VDOMNode {
  const block = streamingBlock(thread.threadState.run);
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
