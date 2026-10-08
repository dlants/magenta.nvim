import type {
  MagentaServer,
  NativeMessageIdx,
  Operation,
  OperationSuccessMap,
  ProtocolSessionState,
  ReflectAnchor,
  Sandbox,
  ScriptRunner,
  SessionId,
  StopReason,
  SubmissionResult,
  ThreadId,
  ThreadOrigin,
} from "@magenta/server";
import {
  ABORTED,
  type Aborted,
  type ArchiveEntry,
  deleteArchivedThread,
  listArchivedThreads,
  type ServerSessionHost,
  threadCreatedAt,
} from "@magenta/server";
import type { Lsp } from "../capabilities/lsp.ts";
import {
  renderApprovals,
  sessionApprovals,
} from "../capabilities/render-pending-approvals.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { MagentaOptions } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
import type { ScriptInvocationId } from "../scripts/script-manager.ts";
import type { Dispatch } from "../tea/tea.ts";
import { d, type VDOMNode, withBindings, withError } from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import { shortenPath } from "../utils/files.ts";
import { formatTokenCount } from "../utils/tokens.ts";
import { SessionView } from "./session-view.ts";
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
      error: { message: string };
    }
) & {
  parentThreadId: ThreadId | undefined;
  scriptInvocationId: ScriptInvocationId | undefined;
  depth: number;
  lastActivityTime: number;
  lastViewedTime: number;
};

type ArchiveStateFields = {
  left: ThreadId | undefined;
  threadIds: ThreadId[];
  loadedCount: number;
  entries: { [id: ThreadId]: ArchiveEntry };
};

/** What the right column shows beside `left`. A `reflection` is always a
 * direct reflect child of `left`; the overview lists `left`'s reflections. */
export type RightPane =
  | { type: "reflection"; threadId: ThreadId }
  | { type: "reflections-overview" };

/** What the sidebar shows. `left` is the left column's thread; it never says
 * where a command goes. */
export type SidebarState =
  | {
      state: "thread-overview";
      left: ThreadId | undefined;
    }
  | {
      state: "thread-selected";
      left: ThreadId;
      right: RightPane | undefined;
    }
  | ({ state: "archive" } & ArchiveStateFields)
  | ({
      state: "archive-thread-selected";
      archivedThreadId: ThreadId;
    } & ArchiveStateFields);

export type PaneMsg =
  | { type: "reflect-created"; parent: ThreadId; child: ThreadId }
  | { type: "show-reflection"; parent: ThreadId; child: ThreadId }
  | { type: "show-reflections-overview"; thread: ThreadId }
  | { type: "close-right-pane" };

/** The thread the right pane shows, if it shows one. */
function rightThreadId(state: SidebarState): ThreadId | undefined {
  return state.state === "thread-selected" && state.right?.type === "reflection"
    ? state.right.threadId
    : undefined;
}

/** Pure pane transitions. Acting from the right pane's thread descends one
 * level: that thread moves to the left. */
export function paneTransition(
  state: SidebarState,
  msg: PaneMsg,
): SidebarState {
  switch (msg.type) {
    case "reflect-created":
    case "show-reflection":
      return {
        state: "thread-selected",
        left: msg.parent,
        right: { type: "reflection", threadId: msg.child },
      };
    case "show-reflections-overview":
      return {
        state: "thread-selected",
        left: msg.thread,
        right: { type: "reflections-overview" },
      };
    case "close-right-pane":
      return state.state === "thread-selected"
        ? { state: "thread-selected", left: state.left, right: undefined }
        : state;
    default:
      return assertUnreachable(msg);
  }
}

/** `-` with a right pane open: pop exactly one level. Returns undefined when
 * there is no right pane, so the caller falls through to navigate-up. */
export function reflectNavigateUp(
  state: SidebarState,
  getOrigin: (id: ThreadId) => ThreadOrigin | undefined,
): SidebarState | undefined {
  if (state.state !== "thread-selected" || !state.right) return undefined;
  if (state.right.type === "reflection") {
    const origin = getOrigin(state.left);
    if (origin?.type === "reflect") {
      return {
        state: "thread-selected",
        left: origin.sourceThreadId,
        right: { type: "reflection", threadId: state.left },
      };
    }
  }
  return { state: "thread-selected", left: state.left, right: undefined };
}

/** Selecting a thread explicitly: a reflect thread opens beside its parent. */
export function selectThreadPanes(
  id: ThreadId,
  getOrigin: (id: ThreadId) => ThreadOrigin | undefined,
): SidebarState {
  const origin = getOrigin(id);
  return origin?.type === "reflect"
    ? {
        state: "thread-selected",
        left: origin.sourceThreadId,
        right: { type: "reflection", threadId: id },
      }
    : { state: "thread-selected", left: id, right: undefined };
}

export type Msg =
  | PaneMsg
  | { type: "reflect-navigate-up" }
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
 * kind of result it settled on. */
type StoppedReason =
  | StopReason
  | Exclude<SubmissionResult["type"], "completed" | "failed">;

/** The view adapter over a Session: selection, expansion, viewed timestamps,
 * archive navigation and the NvimThread wrappers. The session owns identity,
 * hierarchy, construction and lifecycle; lifecycle methods here delegate. */
/** Pure tie-break behind `Chat.externalTarget`. `threadIds` is in creation
 * order. */
export function pickExternalTarget({
  visible,
  lastCursorThreadId,
  threadIds,
}: {
  visible: ThreadId[];
  lastCursorThreadId: ThreadId | undefined;
  threadIds: ThreadId[];
}): ThreadId | undefined {
  if (visible.length === 1) return visible[0];
  if (
    lastCursorThreadId &&
    (visible.length === 0 || visible.includes(lastCursorThreadId))
  ) {
    return lastCursorThreadId;
  }
  if (visible.length > 1) return visible[0];
  return threadIds.at(-1);
}

export class Chat {
  state: SidebarState;
  /** The thread whose display/input buffer most recently held the cursor.
   * Only used as the tie-break in `externalTarget`; cleared when the thread
   * is removed. */
  private cursorThreadId: ThreadId | undefined;
  get lastCursorThreadId(): ThreadId | undefined {
    return this.cursorThreadId;
  }
  recordCursorThread(id: ThreadId): void {
    if (this.wrapper(id)) this.cursorThreadId = id;
  }
  readonly session: SessionView;
  readonly sessionId: SessionId;
  private readonly sessionTopic: { type: "session"; sessionId: SessionId };
  private unsubscribeSession: () => void;
  private knownThreadIds = new Set<ThreadId>();
  readonly host: ServerSessionHost;
  readonly server: MagentaServer;
  /** View-local: the NvimThread wrapper per initialized thread. */
  private threadViews = new Map<ThreadId, NvimThread>();
  /** View-local: when the user last looked at each thread. */
  private lastViewedTimes = new Map<ThreadId, number>();
  private expandedThreads = new Set<ThreadId>();
  /** The reflection under the cursor in the open reflection overview, drawn
   * with `MagentaReflectActive` in its source thread. Supplied by Magenta,
   * which owns the overview. */
  getActiveReflectionId: () => ThreadId | undefined = () => undefined;

  readonly scriptRunner: ScriptRunner | undefined;

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
    },
    /** The session this view adapts. Magenta owns it; the view cache is
     * seeded from whatever records already exist. */
    {
      sessionId,
      host,
      server,
      scriptRunner,
    }: {
      sessionId: SessionId;
      host: ServerSessionHost;
      server: MagentaServer;
      scriptRunner: ScriptRunner | undefined;
    },
  ) {
    this.server = server;
    this.state = {
      state: "thread-overview",
      left: undefined,
    };

    this.host = host;
    this.scriptRunner = scriptRunner;
    this.sessionId = sessionId;
    this.sessionTopic = { type: "session", sessionId };
    const initial = server.getState(this.sessionTopic);
    if (!initial) throw new Error(`Unknown session ${sessionId}`);
    this.session = new SessionView(initial);
    this.onSessionState(initial);
    this.unsubscribeSession = server.subscribe(this.sessionTopic, (state) => {
      if (state) this.onSessionState(state);
    });
  }

  /** Adopt a delivered session state: build wrappers for newly ready threads,
   * drop views of removed ones, and let every view re-render. */
  private onSessionState(state: ProtocolSessionState): void {
    this.session.set(state);
    const ids = new Set(state.threads.map((t) => t.id));
    for (const id of this.knownThreadIds) {
      if (!ids.has(id)) this.removeThreadView(id);
    }
    this.knownThreadIds = ids;
    for (const id of ids) this.syncThread(id);
  }

  /** Detach the view from the session. Thread execution is session-owned, so
   * this only drops listeners and view-local wrappers; it destroys nothing. */
  dispose(): void {
    this.unsubscribeSession();
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
      case "ready": {
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
      this.state = { state: "thread-overview", left: id };
      return;
    }
    if (record.state !== "ready") return;
    let thread = this.threadViews.get(id);
    if (!thread) {
      const prepared = this.host.getPrepared(id);
      const { dispatch, getDisplayWidth, nvim, homeDir } = this.context;
      thread = new NvimThread(id, {
        ...prepared,
        dispatch,
        getDisplayWidth,
        nvim,
        homeDir,
        cwd: prepared.environment.cwd,
        options: this.context.getOptions(),
        mcpToolManager: this.host.mcpToolManager,
        chat: this,
        server: this.server,
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
    if (this.cursorThreadId === id) this.cursorThreadId = undefined;
    this.context.removeThreadBuffers?.([id]);
    if (this.state.left === id) {
      this.state = { state: "thread-overview", left: undefined };
    }
    if (
      rightThreadId(this.state) === id &&
      this.state.state === "thread-selected"
    ) {
      this.state = {
        state: "thread-selected",
        left: this.state.left,
        right: undefined,
      };
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
        this.recordActivity(this.getRootAncestorId(msg.id));
      }
      if (msg.msg.type === "submission-ended") {
        this.recordActivity(msg.id);
      }
    }
  }

  /** Record that we've stopped viewing the currently-selected thread, so that
   * any activity from this point on counts as unviewed. */
  private markActiveThreadViewed() {
    for (const id of this.shownThreadIds()) {
      this.lastViewedTimes.set(id, Date.now());
    }
  }

  /** The thread the left column displays, if it displays one. */
  get leftThreadId(): ThreadId | undefined {
    return this.state.state === "thread-selected" ? this.state.left : undefined;
  }

  /** The reflect thread the right column displays, if any. */
  get rightThreadId(): ThreadId | undefined {
    return rightThreadId(this.state);
  }

  /** Threads on screen when the sidebar is visible: at most two. */
  shownThreadIds(): ThreadId[] {
    const ids: ThreadId[] = [];
    if (this.leftThreadId) ids.push(this.leftThreadId);
    if (this.rightThreadId) ids.push(this.rightThreadId);
    return ids;
  }

  private myUpdate(msg: Msg) {
    switch (msg.type) {
      case "set-active-thread":
        if (this.session.getThread(msg.id)) {
          this.markActiveThreadViewed();
          this.lastViewedTimes.set(msg.id, Date.now());
          this.state = selectThreadPanes(msg.id, (id) =>
            this.session.getOrigin(id),
          );
        }
        return;

      case "reflect-created":
      case "show-reflection":
      case "show-reflections-overview":
      case "close-right-pane":
        this.markActiveThreadViewed();
        this.state = paneTransition(this.state, msg);
        return;

      case "reflect-navigate-up": {
        const next = reflectNavigateUp(this.state, (id) =>
          this.session.getOrigin(id),
        );
        if (next) {
          this.markActiveThreadViewed();
          this.state = next;
        } else {
          this.myUpdate({ type: "threads-navigate-up" });
        }
        return;
      }

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
            left: this.state.left,
          };
          return;
        }
        // If we're viewing a thread and it has a parent, navigate to parent
        if (this.state.state === "thread-selected" && this.state.left) {
          const parentThreadId = this.session.getThread(
            this.state.left,
          )?.parentThreadId;
          if (parentThreadId) {
            // Navigate to parent thread
            this.state = {
              state: "thread-selected",
              left: parentThreadId,
              right: undefined,
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
          left: this.state.left,
        };
        return;

      case "threads-overview":
        this.markActiveThreadViewed();
        // Force navigation to thread overview regardless of current state
        this.state = {
          state: "thread-overview",
          left: this.state.left,
        };
        return;

      case "delete-thread":
        void this.deleteThread(this.session.getRootAncestorId(msg.id));
        return;

      case "delete-thread-subtree":
        void this.deleteThread(msg.id);
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
            left: this.state.left,
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
          left: this.state.left,
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
            left: this.state.left,
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
          left: this.state.left,
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

  /** Pull the current session state synchronously. Operations that create or
   * delete threads call this so the result is visible before the next
   * (microtask-coalesced) delivery. */
  refreshSession(): void {
    const state = this.server.getState(this.sessionTopic);
    if (state) this.onSessionState(state);
  }

  /** Create a thread through the server; it is visible in the view once this
   * resolves. */
  async createThread(
    op:
      | { type: "thread.create"; agent?: string }
      | { type: "thread.reflect"; threadId: ThreadId; anchor?: ReflectAnchor },
  ): Promise<ThreadId | Aborted> {
    const result = await this.execute(
      op.type === "thread.create" ? { ...op, sessionId: this.sessionId } : op,
    );
    if (result.type === "aborted") return ABORTED;
    this.refreshSession();
    return result.threadId;
  }

  /** Execute an operation, turning an error result into a thrown Error. */
  async execute<O extends Operation>(
    op: O,
  ): Promise<OperationSuccessMap[O["type"]]> {
    const result = await this.server.execute(op);
    if (result.type === "error") throw new Error(result.message);
    return result;
  }

  getMessages() {
    const shown = this.leftThreadId;
    if (shown && this.session.getThread(shown)) {
      const threadState = this.wrapper(shown);
      if (threadState?.state === "initialized") {
        return [...threadState.thread.threadState.messages];
      }
    }
    return [];
  }

  private getRootAncestorId(threadId: ThreadId): ThreadId {
    return this.session.getRootAncestorId(threadId);
  }

  /** The overview tree: session parent/child links plus reflections nested
   * under their source thread (reflections have no `parentThreadId`). */
  private buildChildrenMap(): Map<ThreadId, ThreadId[]> {
    const map = this.session.buildChildrenMap();
    for (const record of this.session.listThreads()) {
      const origin = record.origin;
      if (origin?.type !== "reflect") continue;
      map.set(origin.sourceThreadId, [
        ...(map.get(origin.sourceThreadId) ?? []),
        record.id,
      ]);
    }
    return map;
  }

  private recordActivity(threadId: ThreadId): void {
    void this.server.execute({ type: "thread.recordActivity", threadId });
  }

  /** Delete a thread and its subtree; the view drops it right away. */
  async deleteThread(threadId: ThreadId): Promise<void> {
    await this.server.execute({ type: "thread.delete", threadId });
    this.refreshSession();
  }

  /** Abort a thread and its descendants, returning its unsent input. */
  async abortThread(
    threadId: ThreadId,
  ): Promise<{ unsent: ReadonlyArray<string> }> {
    const result = await this.execute({ type: "thread.abort", threadId });
    return { unsent: result.unsent };
  }

  isSandboxBypassed(threadId: ThreadId | undefined): boolean {
    return threadId !== undefined && this.session.isSandboxBypassed(threadId);
  }

  async toggleSandboxBypass(threadId: ThreadId): Promise<void> {
    await this.server.execute({ type: "sandbox.toggleBypass", threadId });
    this.refreshSession();
  }

  approveAllPendingInSubtree(threadId: ThreadId): void {
    void this.server.execute({
      type: "approval.approveAllInSubtree",
      threadId,
    });
  }

  private collectSubtreeViolationViews(
    threadId: ThreadId,
    childrenMap: Map<ThreadId, ThreadId[]>,
  ): VDOMNode[] {
    const views: VDOMNode[] = [];
    if (this.session.getPendingApprovals(threadId).length > 0) {
      views.push(
        renderApprovals(sessionApprovals(this.session, this.server, threadId)),
      );
    }
    const children = childrenMap.get(threadId) ?? [];
    for (const childId of children) {
      views.push(...this.collectSubtreeViolationViews(childId, childrenMap));
    }
    return views;
  }

  /** A thread wants the user's attention if it has unviewed activity (a
   * completed submission or a pending permission approval) and has not yielded. */
  threadNeedsAttention(threadId: ThreadId): boolean {
    const wrapper = this.wrapper(threadId);
    if (wrapper === undefined || wrapper.state !== "initialized") return false;
    const loopState = wrapper.thread.threadState.run;
    // A yielded thread has finished its work; a streaming thread is actively
    // working. Neither needs the user's attention.
    if (loopState.type === "yielded") return false;
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
      this.renderThread(threadId, depth, this.state.left, undefined, {
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
    if (thread.threadState.title) {
      return thread.threadState.title;
    }

    // Find the first user message text
    const messages = thread.threadState.messages;
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
    left: ThreadId | undefined,
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
    const marker = threadId === left ? "*" : "-";
    const indent = "  ".repeat(depth);
    const threadWrapper = this.wrapper(threadId);
    const threadType =
      threadWrapper?.state === "initialized"
        ? threadWrapper.thread.threadState.threadType
        : undefined;
    const icon =
      this.session.getOrigin(threadId)?.type === "reflect"
        ? "💭 "
        : threadType === "docker_root"
          ? "🐳 "
          : "";

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
      const tokenCount = threadWrapper.thread.threadState.lastStopTokenCount;
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
    depth: number,
    childrenMap: Map<ThreadId, ThreadId[]>,
    left: ThreadId | undefined,
    views: VDOMNode[],
  ) {
    if (!this.wrapper(threadId)) return;
    views.push(this.renderThread(threadId, depth, left));
    const children = childrenMap.get(threadId) || [];
    for (const childId of children) {
      this.renderThreadSubtree(childId, depth + 1, childrenMap, left, views);
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
        record.scriptInvocationId === undefined &&
        record.origin?.type !== "reflect"
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
        this.renderThread(id, 0, this.state.left, {
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
            1,
            childrenMap,
            this.state.left,
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
        const count = ctx.selection?.lines.length ?? 1;
        const ids = this.state.threadIds.slice(idx, idx + count);
        this.myDispatch({ type: "archive-delete-threads", ids });
      },
    });
  }

  /** Threads on screen. Only used to pick external targets. */
  private visibleThreadIds(sidebarVisible: boolean): ThreadId[] {
    return sidebarVisible ? this.shownThreadIds() : [];
  }

  /** Target for commands that come from outside magenta (code buffers,
   * pickers): the one visible thread; otherwise whichever visible (or, with
   * none visible, any) thread last held the cursor; otherwise the newest. */
  externalTarget(sidebarVisible: boolean): ThreadId | undefined {
    return pickExternalTarget({
      visible: this.visibleThreadIds(sidebarVisible),
      lastCursorThreadId: this.cursorThreadId,
      threadIds: this.session
        .listThreads()
        .filter((t) => t.state === "ready" && !t.parentThreadId)
        .map((t) => t.id),
    });
  }

  getThread(id: ThreadId): NvimThread {
    const threadWrapper = this.wrapper(id);
    if (!(threadWrapper && threadWrapper.state === "initialized")) {
      throw new Error(`Thread ${id} not initialized yet...`);
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
  }): Promise<ThreadId | Aborted> {
    const sourceWrapper = this.wrapper(sourceThreadId);
    if (!sourceWrapper || sourceWrapper.state !== "initialized") {
      throw new Error(`Thread ${sourceThreadId} not available for forking`);
    }
    const sourceThread = sourceWrapper.thread;
    const result = await this.execute({
      type: "thread.fork",
      threadId: sourceThreadId,
      ...(truncateAtMessageIdx !== undefined
        ? { nativeMessageIdx: truncateAtMessageIdx }
        : {}),
    });
    if (result.type === "aborted") return ABORTED;
    const newThreadId = result.threadId;
    this.refreshSession();
    const origin = this.session.getOrigin(newThreadId);
    if (origin?.type !== "fork") return newThreadId;
    const idx = origin.nativeMessageIdx;
    const wrapper = this.wrapper(newThreadId);
    if (!wrapper || wrapper.state !== "initialized") return newThreadId;
    const thread = wrapper.thread;

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

    return newThreadId;
  }

  threadHasPendingApprovals(threadId: ThreadId): boolean {
    if (this.getThreadPendingApprovalTools(threadId).length > 0) return true;
    return this.session.getPendingApprovals(threadId).length > 0;
  }
  getThreadPendingApprovalTools(_threadId: ThreadId): never[] {
    return [];
  }

  /** How a resting thread stopped: the tool loop's stop reason, or the kind of the
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
        const loopState = thread.threadState.run;
        const lastSubmissionResult =
          loopState.type === "idle" || loopState.type === "destroyed"
            ? loopState.lastResult
            : undefined;

        const summary = {
          title: thread.threadState.title,
          status: (() => {
            // Check mode for thread-specific states first
            const teardownMessage =
              this.session.getThread(threadId)?.teardownMessage;
            if (teardownMessage) {
              return {
                type: "running" as const,
                activity: `🐳 ${teardownMessage}`,
              };
            }
            if (loopState.type === "yielded") {
              return {
                type: "yielded" as const,
                response: renderYield(loopState),
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
              case "destroyed":
                if (lastSubmissionResult?.type === "failed") {
                  return {
                    type: "error" as const,
                    message: lastSubmissionResult.error.message,
                  };
                }
                return {
                  type: "stopped" as const,
                  reason:
                    lastSubmissionResult?.type === "completed"
                      ? lastSubmissionResult.stopReason
                      : (lastSubmissionResult?.type ?? "end_turn"),
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

        // Normal `r` anywhere outside a highlight reflects on the whole thread.
        return withBindings(
          d`${parentView}${threadView({
            thread,
            dispatch: (msg) =>
              this.context.dispatch({
                type: "thread-msg",
                id: thread.id,
                msg,
              }),
          })}`,
          {
            r: (ctx) => {
              if (ctx.selection) return;
              this.context.dispatch({
                type: "thread-msg",
                id: thread.id,
                msg: { type: "reflect-selection" },
              });
            },
          },
        );
      }
      case "error":
        return d`Error: ${threadWrapper.error.message}`;
      default:
        assertUnreachable(threadWrapper);
    }
  }
}
