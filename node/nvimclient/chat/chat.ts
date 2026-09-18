import type { NativeMessageIdx, ScriptRunner, ThreadId } from "@magenta/server";
import {
  type ArchiveEntry,
  deleteArchivedThread,
  listArchivedThreads,
  type Session,
  threadCreatedAt,
} from "@magenta/server";
import type { Lsp } from "../capabilities/lsp.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { MagentaOptions } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Sandbox } from "../sandbox-manager.ts";
import type { ScriptInvocationId } from "../scripts/script-manager.ts";
import type { Dispatch } from "../tea/tea.ts";
import { d, type VDOMNode, withBindings, withError } from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import { shortenPath } from "../utils/files.ts";
import { formatTokenCount } from "../utils/tokens.ts";
import type { CommandRegistry } from "./commands/registry.ts";
import type { NvimSessionHost } from "./session-host.ts";
import { NvimThread } from "./thread.ts";
import { renderYield, view as threadView } from "./thread-view.ts";

const ARCHIVE_PAGE_SIZE = 50;

const ARCHIVE_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A read-only projection of a session record plus the view-local state Chat
 * owns (the NvimThread wrapper, viewed timestamps and derived depth). Nothing
 * here is mutable server state: Chat reads it fresh out of the session. */
type ThreadWrapper = (
  | {
      /** The session has not finished constructing this thread. */
      state: "pending";
    }
  | {
      /** The server thread exists but this view has not built its wrapper
       * yet (the change event that builds it hasn't been observed). */
      state: "view-pending";
    }
  | {
      state: "initialized";
      thread: NvimThread;
    }
  | {
      state: "error";
      error: Error;
    }
) & {
  parentThreadId: ThreadId | undefined;
  scriptInvocationId: ScriptInvocationId | undefined;
  depth: number;
  lastActivityTime: number;
  lastViewedTime: number;
};

type ArchiveStateFields = {
  activeThreadId: ThreadId | undefined;
  threadIds: ThreadId[];
  loadedCount: number;
  entries: { [id: ThreadId]: ArchiveEntry };
};

type ChatState =
  | {
      state: "thread-overview";
      activeThreadId: ThreadId | undefined;
    }
  | {
      state: "thread-selected";
      activeThreadId: ThreadId;
    }
  | ({ state: "archive" } & ArchiveStateFields)
  | ({
      state: "archive-thread-selected";
      archivedThreadId: ThreadId;
    } & ArchiveStateFields);

export type Msg =
  | {
      type: "set-active-thread";
      id: ThreadId;
    }
  | {
      type: "threads-navigate-up";
    }
  | {
      type: "threads-overview";
    }
  | {
      type: "toggle-thread-expand";
      id: ThreadId;
    }
  | {
      type: "delete-thread";
      id: ThreadId;
    }
  | {
      type: "delete-thread-subtree";
      id: ThreadId;
    }
  | {
      type: "archive-open";
    }
  | {
      type: "archive-restore";
    }
  | {
      type: "set-active-archive-thread";
      id: ThreadId;
    }
  | {
      type: "archive-listed";
      entries: ArchiveEntry[];
    }
  | {
      type: "archive-navigate-back";
    }
  | {
      type: "archive-load-more";
    }
  | {
      type: "archive-delete-thread";
      id: ThreadId;
    }
  | {
      type: "archive-delete-threads";
      ids: ThreadId[];
    };

export type ChatMsg = {
  type: "chat-msg";
  msg: Msg;
};

/** How an idle thread came to rest, as a label: a provider stop reason, the
 * kind of result it settled on, or a supervisor's own stop message. */
type StoppedReason = string;

/** The view adapter over a Session: selection, expansion, viewed timestamps,
 * archive navigation and the NvimThread wrappers. The session owns identity,
 * hierarchy, construction and lifecycle; lifecycle methods here delegate. */
export class Chat {
  state: ChatState;
  readonly session: Session;
  readonly host: NvimSessionHost;
  /** View-local: the NvimThread wrapper per initialized thread. */
  private threadViews = new Map<ThreadId, NvimThread>();
  /** View-local: when the user last looked at each thread. */
  private lastViewedTimes = new Map<ThreadId, number>();
  private expandedThreads = new Set<ThreadId>();

  get scriptRunner(): ScriptRunner | undefined {
    return this.session.scriptRunner;
  }

  constructor(
    readonly context: {
      dispatch: Dispatch<RootMsg>;
      getDisplayWidth: () => number;
      getOptions: () => MagentaOptions;
      cwd: NvimCwd;
      homeDir: HomeDir;
      nvim: Nvim;
      lsp: Lsp;
      sandbox: Sandbox;
      removeThreadBuffers?: (ids: ThreadId[]) => void;
      removeArchivedThreadBuffers: (ids: ThreadId[]) => void;
      /** Expands `@file:`, `@diff`, ... when a submission is delivered. */
      commandRegistry: CommandRegistry;
    },
    /** The session this view adapts. Magenta owns it; the view cache is
     * seeded from whatever records already exist. */
    { session, host }: { session: Session; host: NvimSessionHost },
  ) {
    this.state = {
      state: "thread-overview",
      activeThreadId: undefined,
    };

    this.host = host;
    this.session = session;
    this.session.on("changed", this.syncThread);
    this.session.on("removed", this.removeThreadView);
    for (const record of this.session.listThreads()) {
      this.syncThread(record.id);
    }
  }

  /** Detach the view from the session. Thread execution is session-owned, so
   * this only drops listeners and view-local wrappers; it destroys nothing. */
  dispose(): void {
    this.session.off("changed", this.syncThread);
    this.session.off("removed", this.removeThreadView);
    for (const view of this.threadViews.values()) view.dispose();
    this.threadViews.clear();
  }
  /** Project one session record into the shape the views read. */
  private wrapper(id: ThreadId): ThreadWrapper | undefined {
    const record = this.session.getThread(id);
    if (!record) return undefined;
    const fields = {
      parentThreadId: record.parentThreadId,
      scriptInvocationId: record.scriptInvocationId,
      depth: this.depth(id),
      lastActivityTime: record.lastActivityTime,
      lastViewedTime: this.lastViewedTimes.get(id) ?? record.lastActivityTime,
    };
    switch (record.state) {
      case "pending":
        return { ...fields, state: "pending" };
      case "error":
        return { ...fields, state: "error", error: record.error };
      case "initialized": {
        const thread = this.threadViews.get(id);
        return thread
          ? { ...fields, state: "initialized", thread }
          : { ...fields, state: "view-pending" };
      }
      default:
        return assertUnreachable(record);
    }
  }

  /** All projected records, keyed by thread id. Read-only: mutating the
   * returned objects does not change session state. */
  get threadWrappers(): Readonly<{
    [id: ThreadId]: ThreadWrapper | undefined;
  }> {
    const wrappers: { [id: ThreadId]: ThreadWrapper } = {};
    for (const record of this.session.listThreads()) {
      const wrapper = this.wrapper(record.id);
      if (wrapper) wrappers[record.id] = wrapper;
    }
    return wrappers;
  }

  private depth(id: ThreadId): number {
    let depth = 0;
    const seen = new Set<ThreadId>([id]);
    let parent = this.session.getThread(id)?.parentThreadId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      depth += 1;
      parent = this.session.getThread(parent)?.parentThreadId;
    }
    return depth;
  }

  /** Build the NvimThread wrapper the first time a thread is ready. Server
   * record state is read through `wrapper`, not copied here. */
  private syncThread = (id: ThreadId): void => {
    const record = this.session.getThread(id);
    if (!record) return;
    if (!this.lastViewedTimes.has(id)) {
      this.lastViewedTimes.set(id, Date.now());
    }
    if (record.state === "error" && this.state.state === "thread-selected") {
      this.state = { state: "thread-overview", activeThreadId: id };
      return;
    }
    if (record.state !== "initialized") return;
    let thread = this.threadViews.get(id);
    if (!thread) {
      const prepared = this.host.contexts.get(id);
      // The host records a prepared context before the session registers the
      // thread, so an initialized record always has one.
      if (!prepared) return;
      thread = new NvimThread(id, record.thread, record.compactor, {
        ...prepared,
        chat: this,
      });
      this.threadViews.set(id, thread);
    }
    thread.onThreadUpdate();
  };

  private removeThreadView = (id: ThreadId): void => {
    this.threadViews.get(id)?.dispose();
    this.threadViews.delete(id);
    this.lastViewedTimes.delete(id);
    this.expandedThreads.delete(id);
    this.context.removeThreadBuffers?.([id]);
    if (this.state.activeThreadId === id) {
      this.state = { state: "thread-overview", activeThreadId: undefined };
    }
  };

  update(msg: RootMsg) {
    if (msg.type === "chat-msg") {
      this.myUpdate(msg.msg);
      return;
    }

    if (msg.type === "thread-msg") {
      const thread = this.threadViews.get(msg.id);
      if (!thread) return;
      thread.update(msg);
      // Activity is session state; the view only reports what it observed.
      if (msg.msg.type === "send-message") {
        this.session.recordActivity(this.getRootAncestorId(msg.id));
      }
      if (
        msg.msg.type === "turn-ended" ||
        msg.msg.type === "permission-pending-change"
      ) {
        this.session.recordActivity(msg.id);
      }
    }
  }

  /** Record that we've stopped viewing the currently-selected thread, so that
   * any activity from this point on counts as unviewed. */
  private markActiveThreadViewed() {
    if (this.state.state === "thread-selected" && this.state.activeThreadId) {
      this.lastViewedTimes.set(this.state.activeThreadId, Date.now());
    }
  }

  private myUpdate(msg: Msg) {
    switch (msg.type) {
      case "set-active-thread":
        if (this.session.getThread(msg.id)) {
          this.markActiveThreadViewed();
          this.lastViewedTimes.set(msg.id, Date.now());
          this.state = {
            state: "thread-selected",
            activeThreadId: msg.id,
          };
        }
        return;

      case "threads-navigate-up":
        this.markActiveThreadViewed();
        if (this.state.state === "archive-thread-selected") {
          const { archivedThreadId: _, ...archiveState } = this.state;
          this.state = { ...archiveState, state: "archive" };
          return;
        }
        if (this.state.state === "archive") {
          this.state = {
            state: "thread-overview",
            activeThreadId: this.state.activeThreadId,
          };
          return;
        }
        // If we're viewing a thread and it has a parent, navigate to parent
        if (
          this.state.state === "thread-selected" &&
          this.state.activeThreadId
        ) {
          const parentThreadId = this.session.getThread(
            this.state.activeThreadId,
          )?.parentThreadId;
          if (parentThreadId) {
            // Navigate to parent thread
            this.state = {
              state: "thread-selected",
              activeThreadId: parentThreadId,
            };

            // Scroll to bottom when navigating to parent
            setTimeout(() => {
              this.context.dispatch({
                type: "sidebar-msg",
                msg: {
                  type: "set-cursor-to-bottom",
                },
              });
            }, 100);

            return;
          }
        }

        // Otherwise, navigate to thread overview
        this.state = {
          state: "thread-overview",
          activeThreadId: this.state.activeThreadId,
        };
        return;

      case "threads-overview":
        this.markActiveThreadViewed();
        // Force navigation to thread overview regardless of current state
        this.state = {
          state: "thread-overview",
          activeThreadId: this.state.activeThreadId,
        };
        return;

      case "delete-thread":
        this.session.deleteThread(this.session.getRootAncestorId(msg.id));
        return;

      case "delete-thread-subtree":
        this.session.deleteThread(msg.id);
        return;

      case "toggle-thread-expand":
        if (this.expandedThreads.has(msg.id)) {
          this.expandedThreads.delete(msg.id);
        } else {
          this.expandedThreads.add(msg.id);
        }
        return;

      case "archive-restore": {
        if (this.state.state === "archive-thread-selected") {
          const { archivedThreadId: _, ...archiveState } = this.state;
          this.state = { ...archiveState, state: "archive" };
        } else if (this.state.state !== "archive") {
          this.state = {
            state: "archive",
            activeThreadId: this.state.activeThreadId,
            threadIds: [],
            loadedCount: ARCHIVE_PAGE_SIZE,
            entries: {},
          };
          void this.loadArchiveList();
        }
        return;
      }

      case "archive-open": {
        this.markActiveThreadViewed();
        this.state = {
          state: "archive",
          activeThreadId: this.state.activeThreadId,
          threadIds: [],
          loadedCount: ARCHIVE_PAGE_SIZE,
          entries: {},
        };
        void this.loadArchiveList();
        return;
      }

      case "set-active-archive-thread": {
        const wasInArchive =
          this.state.state === "archive" ||
          this.state.state === "archive-thread-selected";
        let archiveState: ArchiveStateFields;
        if (
          this.state.state === "archive" ||
          this.state.state === "archive-thread-selected"
        ) {
          archiveState = this.state;
        } else {
          archiveState = {
            activeThreadId: this.state.activeThreadId,
            threadIds: [],
            loadedCount: ARCHIVE_PAGE_SIZE,
            entries: {},
          };
        }
        this.markActiveThreadViewed();
        this.state = {
          ...archiveState,
          state: "archive-thread-selected",
          archivedThreadId: msg.id,
        };
        if (!wasInArchive) void this.loadArchiveList();
        return;
      }

      case "archive-listed": {
        if (
          this.state.state !== "archive" &&
          this.state.state !== "archive-thread-selected"
        )
          return;
        this.state.threadIds = msg.entries.map((entry) => entry.id);
        this.state.entries = {};
        for (const entry of msg.entries) {
          this.state.entries[entry.id] = entry;
        }
        return;
      }

      case "archive-navigate-back": {
        this.state = {
          state: "thread-overview",
          activeThreadId: this.state.activeThreadId,
        };
        return;
      }

      case "archive-load-more": {
        if (this.state.state !== "archive") return;
        this.state.loadedCount += ARCHIVE_PAGE_SIZE;
        return;
      }

      case "archive-delete-thread": {
        if (this.state.state !== "archive") return;
        this.state.threadIds = this.state.threadIds.filter(
          (id) => id !== msg.id,
        );
        delete this.state.entries[msg.id];
        this.context.removeArchivedThreadBuffers([msg.id]);
        void deleteArchivedThread(msg.id).catch((err: Error) => {
          this.context.nvim.logger.error(
            `Failed to delete archived thread ${msg.id}: ${err.message}`,
          );
        });
        return;
      }

      case "archive-delete-threads": {
        if (this.state.state !== "archive") return;
        const idSet = new Set(msg.ids);
        this.state.threadIds = this.state.threadIds.filter(
          (id) => !idSet.has(id),
        );
        this.context.removeArchivedThreadBuffers(msg.ids);
        for (const id of msg.ids) {
          delete this.state.entries[id];
          void deleteArchivedThread(id).catch((err: Error) => {
            this.context.nvim.logger.error(
              `Failed to delete archived thread ${id}: ${err.message}`,
            );
          });
        }
        return;
      }

      default:
        assertUnreachable(msg);
    }
  }

  /** Read the listable archived threads off disk and dispatch them into the
   * archive state. */
  private async loadArchiveList(): Promise<void> {
    try {
      const entries = await listArchivedThreads();
      this.myDispatch({ type: "archive-listed", entries });
    } catch (err) {
      this.context.nvim.logger.error(
        `Failed to list archived threads: ${(err as Error).message}`,
      );
    }
  }

  private myDispatch(msg: Msg): void {
    this.context.dispatch({ type: "chat-msg", msg });
  }

  getMessages() {
    if (
      this.state.state === "thread-selected" &&
      this.session.getThread(this.state.activeThreadId)
    ) {
      const threadState = this.wrapper(this.state.activeThreadId);
      if (threadState?.state === "initialized") {
        return [...threadState.thread.thread.getProviderMessages()];
      }
    }
    return [];
  }

  private getRootAncestorId(threadId: ThreadId): ThreadId {
    return this.session.getRootAncestorId(threadId);
  }

  private buildChildrenMap(): Map<ThreadId, ThreadId[]> {
    return this.session.buildChildrenMap();
  }

  /** Abort a thread and its descendants. */
  abortThread(threadId: ThreadId): ReturnType<Session["abortThread"]> {
    return this.session.abortThread(threadId);
  }

  isSandboxBypassed(threadId: ThreadId | undefined): boolean {
    return this.host.isSandboxBypassed(threadId, this.session);
  }

  toggleSandboxBypass(threadId: ThreadId): void {
    this.host.toggleSandboxBypass(threadId, this.session);
  }

  approveAllPendingInSubtree(threadId: ThreadId): void {
    this.host.approveAllPendingInSubtree(threadId, this.session);
  }

  private collectSubtreeViolationViews(
    threadId: ThreadId,
    childrenMap: Map<ThreadId, ThreadId[]>,
  ): VDOMNode[] {
    const views: VDOMNode[] = [];
    const wrapper = this.wrapper(threadId);
    if (
      wrapper?.state === "initialized" &&
      wrapper.thread.sandboxViolationHandler
    ) {
      const handler = wrapper.thread.sandboxViolationHandler;
      if (handler.getPendingViolations().size > 0) {
        views.push(handler.view());
      }
    }
    const children = childrenMap.get(threadId) ?? [];
    for (const childId of children) {
      views.push(...this.collectSubtreeViolationViews(childId, childrenMap));
    }
    return views;
  }

  /** A thread wants the user's attention if it has unviewed activity (a
   * completed turn or a pending permission approval) and has not yielded. */
  threadNeedsAttention(threadId: ThreadId): boolean {
    const wrapper = this.wrapper(threadId);
    if (wrapper === undefined || wrapper.state !== "initialized") return false;
    const core = wrapper.thread.thread;
    // A yielded thread has finished its work; a streaming thread is actively
    // working. Neither needs the user's attention.
    if (core.yielded) return false;
    const loopState = core.loopState;
    if (loopState.type === "running" && loopState.activity.type === "streaming")
      return false;
    return wrapper.lastActivityTime > wrapper.lastViewedTime;
  }

  /** Whether any thread in a script-owned subtree wants attention. */
  scriptSubtreeNeedsAttention(threadId: ThreadId): boolean {
    const childrenMap = this.buildChildrenMap();
    const visit = (id: ThreadId): boolean =>
      this.threadNeedsAttention(id) || (childrenMap.get(id) ?? []).some(visit);
    return visit(threadId);
  }

  /**
   * Render a script-owned thread and its subtree, indented starting at the
   * given base depth (the script row sits above at depth 0). Used by the
   * Scripts section in the overview.
   */
  renderScriptThreadSubtree(threadId: ThreadId, baseDepth: number): VDOMNode[] {
    const childrenMap = this.buildChildrenMap();
    const views: VDOMNode[] = [];
    this.renderScriptSubtreeInner(threadId, childrenMap, baseDepth, views);
    return views;
  }

  private renderScriptSubtreeInner(
    threadId: ThreadId,
    childrenMap: Map<ThreadId, ThreadId[]>,
    depth: number,
    views: VDOMNode[],
  ) {
    if (!this.session.getThread(threadId)) return;
    views.push(
      this.renderThread(threadId, depth, this.state.activeThreadId, undefined, {
        showTokenCount: true,
      }),
    );
    for (const childId of childrenMap.get(threadId) ?? []) {
      this.renderScriptSubtreeInner(childId, childrenMap, depth + 1, views);
    }
  }

  /**
   * Collect pending-permission views for a script-owned thread's subtree, so a
   * collapsed script row never hides a blocking permission prompt.
   */

  collectScriptSubtreeViolationViews(threadId: ThreadId): VDOMNode[] {
    return this.collectSubtreeViolationViews(threadId, this.buildChildrenMap());
  }

  private formatThreadStatus(threadId: ThreadId): string {
    const summary = this.getThreadSummary(threadId);

    switch (summary.status.type) {
      case "missing":
        return "❓ not found";

      case "pending":
        return "⏳ initializing";

      case "running":
        return `⏳ ${summary.status.activity}`;

      case "stopped":
        return `⏹️ stopped (${summary.status.reason})`;

      case "yielded":
        return "✅ yielded";

      case "error": {
        const truncatedError =
          summary.status.message.length > 50
            ? `${summary.status.message.substring(0, 47)}...`
            : summary.status.message;
        return `❌ error: ${truncatedError}`;
      }

      default:
        return assertUnreachable(summary.status);
    }
  }

  getThreadDisplayName(threadId: ThreadId): string {
    const threadWrapper = this.wrapper(threadId);
    if (!threadWrapper || threadWrapper.state !== "initialized") {
      return "[Untitled]";
    }

    const thread = threadWrapper.thread;
    if (thread.thread.title) {
      return thread.thread.title;
    }

    // Find the first user message text
    const messages = thread.thread.getProviderMessages();
    for (const message of messages) {
      if (message.role === "user") {
        for (const content of message.content) {
          if (content.type === "text" && content.text.trim()) {
            const text = content.text.trim();
            return text.length > 50 ? `${text.substring(0, 50)}...` : text;
          }
        }
      }
    }

    return "[Untitled]";
  }

  private renderThread(
    threadId: ThreadId,
    depth: number,
    activeThreadId: ThreadId | undefined,
    options?: {
      hasChildren: boolean;
      isExpanded: boolean;
      childCount: number;
    },
    extra?: {
      showTokenCount: boolean;
    },
  ): VDOMNode {
    const displayName = this.getThreadDisplayName(threadId);
    const status = this.formatThreadStatus(threadId);
    const marker = threadId === activeThreadId ? "*" : "-";
    const indent = "  ".repeat(depth);
    const threadWrapper = this.wrapper(threadId);
    const threadType =
      threadWrapper?.state === "initialized"
        ? threadWrapper.thread.thread.threadType
        : undefined;
    const icon = threadType === "docker_root" ? "🐳 " : "";

    const isSandboxBypassed =
      threadWrapper?.state === "initialized"
        ? threadWrapper.thread.isSandboxBypassed
        : false;
    const sandboxIndicator =
      depth === 0 && isSandboxBypassed ? withError(d` SANDBOX OFF `) : d``;

    const bell = this.threadNeedsAttention(threadId) ? "🔔 " : "";

    const expandIndicator = options?.hasChildren
      ? options.isExpanded
        ? "▼ "
        : "▶ "
      : "";
    const childCountSuffix = options?.hasChildren
      ? ` (${options.childCount} subthreads)`
      : "";

    let tokenSuffix = "";
    if (extra?.showTokenCount && threadWrapper?.state === "initialized") {
      const tokenCount = threadWrapper.thread.thread.getLastStopTokenCount();
      if (tokenCount > 0) {
        tokenSuffix = ` [${formatTokenCount(tokenCount)}]`;
      }
    }

    const displayLine = d`${indent}${marker} ${bell}${expandIndicator}${icon}${sandboxIndicator}${displayName}: ${status}${childCountSuffix}${tokenSuffix}`;

    const bindings: Record<string, () => void> = {
      "<CR>": () =>
        this.context.dispatch({
          type: "select-thread-effect",
          id: threadId,
        }),
      dd: () =>
        this.context.dispatch({
          type: "chat-msg",
          msg: {
            type: "delete-thread",
            id: threadId,
          },
        }),
    };

    bindings.t = () =>
      this.context.dispatch({
        type: "thread-msg",
        id: threadId,
        msg: { type: "toggle-sandbox-bypass" },
      });

    if (options?.hasChildren) {
      bindings["="] = () =>
        this.context.dispatch({
          type: "chat-msg",
          msg: {
            type: "toggle-thread-expand",
            id: threadId,
          },
        });
    }

    return withBindings(displayLine, bindings);
  }

  private renderThreadSubtree(
    threadId: ThreadId,
    childrenMap: Map<ThreadId, ThreadId[]>,
    activeThreadId: ThreadId | undefined,
    views: VDOMNode[],
  ) {
    const wrapper = this.wrapper(threadId);
    if (!wrapper) return;
    views.push(this.renderThread(threadId, wrapper.depth, activeThreadId));
    const children = childrenMap.get(threadId) || [];
    for (const childId of children) {
      this.renderThreadSubtree(childId, childrenMap, activeThreadId, views);
    }
  }

  private countSubtreeThreads(
    threadId: ThreadId,
    childrenMap: Map<ThreadId, ThreadId[]>,
  ): number {
    const children = childrenMap.get(threadId) ?? [];
    let count = children.length;
    for (const childId of children) {
      count += this.countSubtreeThreads(childId, childrenMap);
    }
    return count;
  }

  renderThreadOverview() {
    const archiveLink = withBindings(d`[archive]`, {
      "<CR>": () => this.myDispatch({ type: "archive-open" }),
    });

    if (this.session.listThreads().length === 0) {
      return d`# Threads ${archiveLink}

No threads yet`;
    }

    const childrenMap = this.buildChildrenMap();
    const threadViews: VDOMNode[] = [];

    const rootThreads: { id: ThreadId }[] = [];
    for (const record of this.session.listThreads()) {
      // Script-owned threads are rendered nested under their script invocation
      // in the Scripts section, not as top-level threads here.
      if (
        record.parentThreadId === undefined &&
        record.scriptInvocationId === undefined
      ) {
        rootThreads.push({ id: record.id });
      }
    }

    // ThreadIds are uuidv7 (time-ordered), so sorting by id descending yields
    // most-recently-created first. This order is stable regardless of activity.
    rootThreads.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

    for (const { id } of rootThreads) {
      const hasChildren = (childrenMap.get(id)?.length ?? 0) > 0;
      const isExpanded = this.expandedThreads.has(id);
      const childCount = hasChildren
        ? this.countSubtreeThreads(id, childrenMap)
        : 0;

      threadViews.push(
        this.renderThread(id, 0, this.state.activeThreadId, {
          hasChildren,
          isExpanded,
          childCount,
        }),
      );

      if (hasChildren && isExpanded) {
        const children = childrenMap.get(id) ?? [];
        for (const childId of children) {
          this.renderThreadSubtree(
            childId,
            childrenMap,
            this.state.activeThreadId,
            threadViews,
          );
        }
      } else if (hasChildren && !isExpanded) {
        const violationViews = this.collectSubtreeViolationViews(
          id,
          childrenMap,
        );
        for (const violationView of violationViews) {
          threadViews.push(violationView);
        }
      }
    }

    return d`# Threads ${archiveLink}

${threadViews.map((view) => d`${view}\n`)}`;
  }

  renderArchive(): VDOMNode {
    if (this.state.state !== "archive") {
      return d``;
    }

    const backLink = withBindings(d`< back to threads`, {
      "<CR>": () => this.myDispatch({ type: "archive-navigate-back" }),
    });

    if (this.state.threadIds.length === 0) {
      return d`# Archived threads

${backLink}

No archived threads`;
    }

    const rows: VDOMNode[] = [];
    for (const id of this.state.threadIds.slice(0, this.state.loadedCount)) {
      rows.push(d`${this.renderArchiveRow(id)}\n`);
    }

    const remaining = this.state.threadIds.length - this.state.loadedCount;
    const loadMore =
      remaining > 0
        ? withBindings(d`\n[load more] (${remaining.toString()} older)`, {
            "<CR>": () => this.myDispatch({ type: "archive-load-more" }),
          })
        : d``;

    return d`# Archived threads

${backLink}

${rows}${loadMore}`;
  }

  private renderArchiveRow(threadId: ThreadId): VDOMNode {
    if (this.state.state !== "archive") return d``;

    const date = ARCHIVE_DATE_FORMAT.format(threadCreatedAt(threadId));
    const entry = this.state.entries[threadId];
    const title = entry?.title ?? "(untitled)";
    const prefix = entry?.scriptName ? `[${entry.scriptName}] ` : "";
    const cwd = entry?.cwd
      ? `  (${shortenPath(entry.cwd, this.context.homeDir)})`
      : "";

    const line = d`- ${date}  ${prefix}${title}${cwd}`;

    return withBindings(line, {
      "<CR>": () =>
        this.context.dispatch({
          type: "select-archived-thread-effect",
          id: threadId,
        }),
      dd: () =>
        this.myDispatch({ type: "archive-delete-thread", id: threadId }),
      d: (ctx) => {
        if (this.state.state !== "archive") return;
        const idx = this.state.threadIds.indexOf(threadId);
        if (idx === -1) return;
        const count = ctx?.selection?.length ?? 1;
        const ids = this.state.threadIds.slice(idx, idx + count);
        this.myDispatch({ type: "archive-delete-threads", ids });
      },
    });
  }

  /** The root of the active thread's ancestry. */
  getActiveRootThreadId(): ThreadId {
    return this.getRootAncestorId(this.getActiveThread().id);
  }

  /** The active root thread, or `undefined` while the chat has no active
   * thread, that thread hasn't finished initializing, or its root ancestor
   * is not a root thread (script threads are parentless subagents). */
  getActiveRootThreadOrUndefined(): NvimThread | undefined {
    if (!this.state.activeThreadId) return undefined;
    const threadWrapper = this.wrapper(
      this.getRootAncestorId(this.state.activeThreadId),
    );
    if (!(threadWrapper && threadWrapper.state === "initialized")) {
      return undefined;
    }
    const thread = threadWrapper.thread;
    return thread;
  }

  /** The root ancestor of the active thread. */
  getActiveRootThread(): NvimThread {
    const threadWrapper = this.wrapper(this.getActiveRootThreadId());
    if (!(threadWrapper && threadWrapper.state === "initialized")) {
      throw new Error(`Root thread not initialized yet...`);
    }
    const thread = threadWrapper.thread;
    return thread;
  }

  getActiveThread(): NvimThread {
    if (!this.state.activeThreadId) {
      throw new Error(`Chat is not initialized yet... no active thread`);
    }
    const threadWrapper = this.wrapper(this.state.activeThreadId);
    if (!(threadWrapper && threadWrapper.state === "initialized")) {
      throw new Error(
        `Thread ${this.state.activeThreadId} not initialized yet...`,
      );
    }
    return threadWrapper.thread;
  }

  /** Fork through the session, then copy the display context the new thread
   * inherits: per-message view state up to the fork point, the fork marker, and
   * the source's outgoing fork list. */
  async handleForkThread({
    sourceThreadId,
    truncateAtMessageIdx,
  }: {
    sourceThreadId: ThreadId;
    truncateAtMessageIdx?: NativeMessageIdx;
  }): Promise<ThreadId> {
    const sourceWrapper = this.wrapper(sourceThreadId);
    if (!sourceWrapper || sourceWrapper.state !== "initialized") {
      throw new Error(`Thread ${sourceThreadId} not available for forking`);
    }
    const sourceThread = sourceWrapper.thread;
    const idx = truncateAtMessageIdx ?? sourceThread.thread.nativeMessageIdx;

    const newThreadId = await this.session.forkThread(sourceThreadId, idx);
    const wrapper = this.wrapper(newThreadId);
    if (!wrapper || wrapper.state !== "initialized") return newThreadId;
    const thread = wrapper.thread;

    this.host.setSandboxBypassed(
      newThreadId,
      this.isSandboxBypassed(sourceThreadId),
    );

    for (const [idxStr, viewState] of Object.entries(
      sourceThread.state.messageViewState,
    )) {
      const messageIdx = Number(idxStr);
      if (messageIdx > idx) continue;
      thread.state.messageViewState[messageIdx] = {
        ...(viewState.expandedUpdates
          ? { expandedUpdates: { ...viewState.expandedUpdates } }
          : {}),
        ...(viewState.expandedContent
          ? { expandedContent: { ...viewState.expandedContent } }
          : {}),
      };
    }

    const markerIdx = thread.thread.getProviderMessages().length;
    thread.state.messageViewState[markerIdx] = {
      ...thread.state.messageViewState[markerIdx],
      forkedFrom: sourceThreadId,
    };
    sourceThread.state.forkedTo.push({
      childThreadId: newThreadId,
      atMessageIdx: idx,
    });

    return newThreadId;
  }

  threadHasPendingApprovals(threadId: ThreadId): boolean {
    if (this.getThreadPendingApprovalTools(threadId).length > 0) return true;
    const wrapper = this.wrapper(threadId);
    if (!wrapper || wrapper.state !== "initialized") return false;
    return (
      (wrapper.thread.sandboxViolationHandler?.getPendingViolations().size ??
        0) > 0
    );
  }
  getThreadPendingApprovalTools(_threadId: ThreadId): never[] {
    return [];
  }

  /** How a resting thread stopped: the turn's stop reason, or the kind of the
   * non-completed result. `failed` is reported as an error status instead. */
  getThreadSummary(threadId: ThreadId): {
    title?: string | undefined;
    status:
      | { type: "missing" }
      | { type: "pending" }
      | { type: "running"; activity: string }
      | { type: "stopped"; reason: StoppedReason }
      | { type: "yielded"; response: string }
      | { type: "error"; message: string };
  } {
    const threadWrapper = this.wrapper(threadId);
    if (!threadWrapper) {
      return {
        status: { type: "missing" },
      };
    }

    switch (threadWrapper.state) {
      case "pending":
      case "view-pending":
        return {
          status: { type: "pending" },
        };

      case "error":
        return {
          status: {
            type: "error",
            message: threadWrapper.error.message,
          },
        };

      case "initialized": {
        const thread = threadWrapper.thread;
        const loopState = thread.thread.loopState;
        const lastTurnResult = thread.thread.lastResult();

        const summary = {
          title: thread.thread.title,
          status: (() => {
            // Check mode for thread-specific states first
            const teardownMessage = this.session.teardownMessages.get(threadId);
            if (teardownMessage) {
              return {
                type: "running" as const,
                activity: `🐳 ${teardownMessage}`,
              };
            }
            const yielded = thread.thread.yielded;
            if (yielded) {
              return {
                type: "yielded" as const,
                response: renderYield(yielded),
              };
            }
            switch (loopState.type) {
              case "running":
                if (loopState.aborting)
                  return { type: "running" as const, activity: "aborting" };
                switch (loopState.activity.type) {
                  case "preparing":
                    return {
                      type: "running" as const,
                      activity: "preparing",
                    };
                  case "streaming":
                    return {
                      type: "running" as const,
                      activity: "streaming response",
                    };
                  case "running_tools":
                    return {
                      type: "running" as const,
                      activity: this.threadHasPendingApprovals(threadId)
                        ? "waiting for approval"
                        : "executing tools",
                    };
                  default:
                    return assertUnreachable(loopState.activity);
                }
              case "idle":
                if (lastTurnResult?.type === "failed") {
                  return {
                    type: "error" as const,
                    message: lastTurnResult.error.message,
                  };
                }
                if (lastTurnResult?.type === "stopped") {
                  return {
                    type: "stopped" as const,
                    reason:
                      lastTurnResult.reason.kind === "stop"
                        ? lastTurnResult.reason.message
                        : "compaction requested",
                  };
                }
                return {
                  type: "stopped" as const,
                  reason:
                    lastTurnResult?.type === "completed"
                      ? lastTurnResult.stopReason
                      : (lastTurnResult?.type ?? "end_turn"),
                };
              default:
                return assertUnreachable(loopState);
            }
          })(),
        };

        return summary;
      }

      default:
        return assertUnreachable(threadWrapper);
    }
  }

  renderSingleThread(threadId: ThreadId) {
    const threadWrapper = this.wrapper(threadId);

    if (!threadWrapper) {
      return d`Thread not found`;
    }

    switch (threadWrapper.state) {
      case "pending":
      case "view-pending":
        return d`Initializing thread...`;
      case "initialized": {
        const thread = threadWrapper.thread;
        let parentView: string | VDOMNode;

        if (threadWrapper.parentThreadId) {
          const parent = threadWrapper.parentThreadId;
          const parentDisplayName = this.getThreadDisplayName(parent);
          parentView = withBindings(d`Parent thread: ${parentDisplayName}\n`, {
            "<CR>": () =>
              this.context.dispatch({
                type: "select-thread-effect",
                id: parent,
              }),
          });
        } else {
          parentView = "";
        }

        return d`${parentView}${threadView({
          thread,
          dispatch: (msg) =>
            this.context.dispatch({
              type: "thread-msg",
              id: thread.id,
              msg,
            }),
        })}`;
      }
      case "error":
        return d`Error: ${threadWrapper.error.message}`;
      default:
        assertUnreachable(threadWrapper);
    }
  }
}
