import type {
  ScriptInvocation,
  ScriptInvocationId,
  ScriptMeta,
  ScriptManager as ServerScriptManager,
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
  | { type: "catalog-updated" }
  | { type: "invocation-updated"; id: ScriptInvocationId }
  | { type: "toggle-invocation-expand"; id: ScriptInvocationId }
  | { type: "toggle-thread-yield"; id: ThreadId }
  | { type: "toggle-invocation-sandbox"; id: ScriptInvocationId }
  | { type: "abort-invocation"; id: ScriptInvocationId }
  | { type: "delete-invocation"; id: ScriptInvocationId };

export type ScriptMsg = {
  type: "script-msg";
  msg: Msg;
};

/**
 * The editor-side view of script execution. Invocations, child processes and
 * their threads are owned by the session's ScriptManager; this controller only
 * renders them, tracks expansion, opens files, and notifies the user.
 */
export class ScriptController {
  private expandedInvocations = new Set<ScriptInvocationId>();
  private expandedThreads = new Set<ThreadId>();
  private myDispatch: Dispatch<Msg>;

  constructor(
    private context: {
      dispatch: Dispatch<RootMsg>;
      chat: Chat;
      scripts: ServerScriptManager;
      nvim: Nvim;
      cwd: NvimCwd;
      homeDir: HomeDir;
      getOptions: () => MagentaOptions;
    },
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({ type: "script-msg", msg });

    const { scripts } = context;
    scripts.on("catalogChanged", () =>
      this.myDispatch({ type: "catalog-updated" }),
    );
    scripts.on("invocationChanged", (id) =>
      this.myDispatch({ type: "invocation-updated", id }),
    );
    scripts.on("invocationRemoved", (id) => {
      this.expandedInvocations.delete(id);
      this.myDispatch({ type: "catalog-updated" });
    });
    scripts.on("invocationFinished", () => this.notifyFinished());
  }

  update(msg: RootMsg): void {
    // Server-owned state changes arrive as events; script-msg dispatches exist
    // mainly to trigger a re-render through the central loop. Expansion is the
    // exception: it is view state, mutated here.
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
        this.context.scripts.toggleInvocationSandbox(msg.msg.id);
        return;
      case "abort-invocation":
        this.context.scripts.abortInvocation(msg.msg.id);
        return;
      case "delete-invocation":
        this.context.scripts.deleteInvocation(msg.msg.id);
        return;
      case "catalog-updated":
      case "invocation-updated":
        return;
    }
  }

  getCatalog(): ScriptMeta[] {
    return this.context.scripts.getCatalog();
  }

  discover(): Promise<void> {
    return this.context.scripts.discover();
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
    }).catch((e: Error) => this.context.nvim.logger.error(e.message));
  }

  private renderThreadYield(threadId: ThreadId): VDOMNode {
    const result = this.context.scripts.getThreadYield(threadId);
    if (!result) {
      return d``;
    }
    if (result.status === "ok") {
      return d`\n  ⮑ yielded: ${result.value}`;
    }
    return d`\n  ⮑ error: ${result.error}`;
  }

  view(): VDOMNode {
    const invocations: ScriptInvocation[] =
      this.context.scripts.listInvocations();
    if (invocations.length === 0) {
      return d``;
    }

    const rows: VDOMNode[] = [];
    const sortedInvocations = [...invocations].sort((a, b) =>
      a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
    );
    for (const inv of sortedInvocations) {
      const icon =
        inv.status === "running"
          ? "⏳"
          : inv.status === "done"
            ? "✅"
            : inv.status === "aborted"
              ? "⛔"
              : "❌";
      const sandboxIndicator = inv.sandboxBypassed
        ? withError(d` SANDBOX OFF `)
        : d``;
      const isExpanded = this.expandedInvocations.has(inv.id);
      const expandIndicator = isExpanded ? "▼ " : "▶ ";
      const needsAttention =
        inv.status !== "running" ||
        inv.entries.some(
          (e) =>
            e.type === "thread" &&
            this.context.chat.scriptSubtreeNeedsAttention(e.threadId),
        );
      const bell = needsAttention ? "🔔 " : "";

      const invRows: VDOMNode[] = [];
      const headerLine = withBindings(
        d`\n${icon} ${expandIndicator}${bell}${sandboxIndicator}${inv.title ?? inv.scriptName} (${inv.status})`,
        {
          dd: () => this.myDispatch({ type: "delete-invocation", id: inv.id }),
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
            invRows.push(this.renderThreadYield(threadId));
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

      rows.push(
        withBindings(d`${invRows}`, {
          "=": () =>
            this.myDispatch({ type: "toggle-invocation-expand", id: inv.id }),
          a: () => this.myDispatch({ type: "abort-invocation", id: inv.id }),
        }),
      );
    }

    const hr = "─".repeat(40);
    return d`\n${hr}\n# SCRIPTS\n${hr}\n${rows}`;
  }
}
