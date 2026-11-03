import type {
  MagentaServer,
  Operation,
  ProtocolScriptState,
  ProtocolSessionState,
  ScriptInvocationId,
  SessionId,
  ThreadId,
} from "@magenta/server";
import type { Chat } from "../chat/chat.ts";
import { notifyUser } from "../chat/notify.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { MagentaOptions } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Dispatch } from "../tea/tea.ts";
import { d, type VDOMNode, withBindings, withError } from "../tea/view.ts";
import type { AbsFilePath, HomeDir, NvimCwd } from "../utils/files.ts";

export type { ScriptInvocationId };

export type Msg =
  | { type: "state-updated" }
  | { type: "toggle-invocation-expand"; id: ScriptInvocationId }
  | { type: "toggle-thread-yield"; id: ThreadId }
  | { type: "toggle-invocation-sandbox"; id: ScriptInvocationId }
  | { type: "abort-invocation"; id: ScriptInvocationId }
  | { type: "delete-invocation"; id: ScriptInvocationId };

export type ScriptMsg = {
  type: "script-msg";
  msg: Msg;
};

/** Before the first script state arrives, `notifyOnFinish` says whether an
 * already-finished first state is news (true for invocations that appear
 * after the controller started). */
type InvocationView =
  | { type: "pending"; notifyOnFinish: boolean }
  | { type: "loaded"; state: ProtocolScriptState };

/**
 * The editor-side view of script execution. Invocations, child processes and
 * their threads are owned by the server; this controller renders the session
 * state's script list and one script-state subscription per invocation,
 * tracks expansion, opens files, and notifies the user.
 */
export class ScriptController {
  private expandedInvocations = new Set<ScriptInvocationId>();
  private expandedThreads = new Set<ThreadId>();
  private invocations = new Map<ScriptInvocationId, InvocationView>();
  private subscriptions = new Map<ScriptInvocationId, () => void>();
  /** Invocations present when the controller started; finishing before we
   * saw them running is not news. */
  private initialized = false;
  private unsubscribeSession: () => void;
  private myDispatch: Dispatch<Msg>;

  constructor(
    private context: {
      dispatch: Dispatch<RootMsg>;
      chat: Chat;
      server: MagentaServer;
      sessionId: SessionId;
      nvim: Nvim;
      cwd: NvimCwd;
      homeDir: HomeDir;
      getOptions: () => MagentaOptions;
    },
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({ type: "script-msg", msg });

    this.unsubscribeSession = context.server.subscribe(
      { type: "session", sessionId: context.sessionId },
      (state) => this.onSessionState(state),
    );
    this.initialized = true;
  }

  private onSessionState(state: ProtocolSessionState | undefined): void {
    const present = new Set(state?.scripts.invocations.map((i) => i.id) ?? []);
    let changed = false;
    for (const id of present) {
      if (!this.invocations.has(id)) {
        this.watchInvocation(id);
        changed = true;
      }
    }
    for (const id of [...this.invocations.keys()]) {
      if (!present.has(id)) {
        this.dropInvocation(id);
        changed = true;
      }
    }
    // Session state changes on every thread update; only re-render when the
    // invocation set changed (per-invocation changes arrive via their topic).
    if (changed) this.myDispatch({ type: "state-updated" });
  }

  private watchInvocation(id: ScriptInvocationId): void {
    this.invocations.set(id, {
      type: "pending",
      notifyOnFinish: this.initialized,
    });
    const unsubscribe = this.context.server.subscribe(
      { type: "script", invocationId: id },
      (state) => this.onScriptState(id, state),
    );
    // The subscription may have delivered `undefined` synchronously.
    if (this.invocations.has(id)) {
      this.subscriptions.set(id, unsubscribe);
    } else {
      unsubscribe();
    }
  }

  private onScriptState(
    id: ScriptInvocationId,
    state: ProtocolScriptState | undefined,
  ): void {
    const view = this.invocations.get(id);
    if (!view) return;
    if (!state) {
      this.dropInvocation(id);
      this.myDispatch({ type: "state-updated" });
      return;
    }
    const wasRunning =
      view.type === "loaded"
        ? view.state.state.type === "running"
        : view.notifyOnFinish;
    this.invocations.set(id, { type: "loaded", state });
    if (wasRunning && state.state.type !== "running") {
      this.notifyFinished();
    }
    this.myDispatch({ type: "state-updated" });
  }

  private dropInvocation(id: ScriptInvocationId): void {
    const view = this.invocations.get(id);
    if (!view) return;
    this.invocations.delete(id);
    this.subscriptions.get(id)?.();
    this.subscriptions.delete(id);
    if (view.type === "loaded") {
      for (const threadId of view.state.threadIds) {
        this.expandedThreads.delete(threadId);
      }
    }
    this.expandedInvocations.delete(id);
  }

  /** Drop every subscription; view state dies with the controller. */
  dispose(): void {
    this.unsubscribeSession();
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.invocations.clear();
  }

  private execute(op: Operation): void {
    this.context.server
      .execute(op)
      .then((result) => {
        if (result.type === "error") {
          this.context.nvim.logger.error(result.message);
        }
      })
      .catch((e: unknown) =>
        this.context.nvim.logger.error(
          e instanceof Error ? e.message : String(e),
        ),
      );
  }

  update(msg: RootMsg): void {
    if (msg.type !== "script-msg") return;
    switch (msg.msg.type) {
      case "toggle-invocation-expand":
        if (this.expandedInvocations.has(msg.msg.id)) {
          this.expandedInvocations.delete(msg.msg.id);
        } else {
          this.expandedInvocations.add(msg.msg.id);
        }
        return;
      case "toggle-thread-yield":
        if (this.expandedThreads.has(msg.msg.id)) {
          this.expandedThreads.delete(msg.msg.id);
        } else {
          this.expandedThreads.add(msg.msg.id);
        }
        return;
      case "toggle-invocation-sandbox":
        this.execute({
          type: "script.toggleSandbox",
          invocationId: msg.msg.id,
        });
        return;
      case "abort-invocation":
        this.execute({ type: "script.abort", invocationId: msg.msg.id });
        return;
      case "delete-invocation":
        this.execute({ type: "script.delete", invocationId: msg.msg.id });
        return;
      case "state-updated":
        return;
    }
  }

  private notifyFinished(): void {
    notifyUser(
      { nvim: this.context.nvim, options: this.context.getOptions() },
      "script-finished",
    );
  }

  private openScriptFile(file: string): void {
    openFileInNonMagentaWindow(file as AbsFilePath, {
      nvim: this.context.nvim,
      cwd: this.context.cwd,
      homeDir: this.context.homeDir,
      options: this.context.getOptions(),
    }).catch((e: unknown) =>
      this.context.nvim.logger.error(
        e instanceof Error ? e.message : String(e),
      ),
    );
  }

  private renderThreadYield(
    inv: ProtocolScriptState,
    threadId: ThreadId,
  ): VDOMNode {
    const result = inv.threadYields[threadId];
    if (!result) {
      return d``;
    }
    if (result.status === "ok") {
      return d`\n  ⮑ yielded: ${JSON.stringify(result.value)}`;
    }
    return d`\n  ⮑ error: ${result.error}`;
  }

  view(): VDOMNode {
    const invocations = [...this.invocations.values()].flatMap((view) =>
      view.type === "loaded" &&
      !this.context.chat.isScriptDeleted(view.state.id)
        ? [view.state]
        : [],
    );
    if (invocations.length === 0) {
      return d``;
    }
    const sortedInvocations = [...invocations].sort((a, b) =>
      a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
    );
    const rows = sortedInvocations.map((inv) => this.renderInvocation(inv));
    const hr = "─".repeat(40);
    return d`\n${hr}\n# SCRIPTS\n${hr}\n${rows}`;
  }

  /** A row in the overview's Deleted section, with its own header bindings. */
  renderDeletedInvocation(
    id: ScriptInvocationId,
    headerBindings: { dd: () => void; r: () => void },
  ): VDOMNode | undefined {
    const view = this.invocations.get(id);
    if (view?.type !== "loaded") return undefined;
    return this.renderInvocation(view.state, headerBindings);
  }

  private renderInvocation(
    inv: ProtocolScriptState,
    headerBindings?: { dd: () => void; r: () => void },
  ): VDOMNode {
    const icon =
      inv.state.type === "running"
        ? "⏳"
        : inv.state.type === "done"
          ? "✅"
          : inv.state.type === "aborted"
            ? "⛔"
            : "❌";
    const sandboxIndicator = inv.sandboxBypassed
      ? withError(d` SANDBOX OFF `)
      : d``;
    const isExpanded = this.expandedInvocations.has(inv.id);
    const expandIndicator = isExpanded ? " " : " ";
    const needsAttention =
      inv.state.type !== "running" ||
      inv.entries.some(
        (e) =>
          e.type === "thread" &&
          this.context.chat.scriptSubtreeNeedsAttention(e.threadId),
      );
    const bell = needsAttention ? "🔔 " : "";

    const invRows: VDOMNode[] = [];
    const headerLine = withBindings(
      d`\n${icon} ${expandIndicator}${bell}${sandboxIndicator}${inv.title ?? inv.scriptName} (${inv.state.type})`,
      {
        dd: () => this.myDispatch({ type: "delete-invocation", id: inv.id }),
        ...headerBindings,
        t: () =>
          this.myDispatch({
            type: "toggle-invocation-sandbox",
            id: inv.id,
          }),
      },
    );
    const fileLine = withBindings(d`\n  ${inv.file}`, {
      "<CR>": () => this.openScriptFile(inv.file),
    });
    invRows.push(headerLine);
    invRows.push(fileLine);

    if (isExpanded) {
      invRows.push(d`\n  parameters: ${JSON.stringify(inv.parameters)}`);
      for (const entry of inv.entries) {
        if (entry.type === "log") {
          invRows.push(d`\n  > ${entry.message}`);
          continue;
        }

        const threadViews = this.context.chat.renderScriptThreadSubtree(
          entry.threadId,
          1,
        );
        const threadId = entry.threadId;
        threadViews.forEach((view, idx) => {
          if (idx === 0) {
            invRows.push(
              d`\n🧵 ${withBindings(view, {
                ...view.bindings,
                "=": () =>
                  this.myDispatch({
                    type: "toggle-thread-yield",
                    id: threadId,
                  }),
              })}`,
            );
          } else {
            invRows.push(d`\n${view}`);
          }
        });

        if (this.expandedThreads.has(threadId)) {
          invRows.push(this.renderThreadYield(inv, threadId));
        }
      }
    } else {
      for (const entry of inv.entries) {
        if (entry.type !== "thread") continue;
        for (const view of this.context.chat.collectScriptSubtreeViolationViews(
          entry.threadId,
        )) {
          invRows.push(d`\n${view}`);
        }
      }
    }

    return withBindings(d`${invRows}`, {
      "=": () =>
        this.myDispatch({ type: "toggle-invocation-expand", id: inv.id }),
      a: () => this.myDispatch({ type: "abort-invocation", id: inv.id }),
    });
  }
}
