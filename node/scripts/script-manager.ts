import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { ScriptCatalogEntry, ThreadId } from "@magenta/core";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import { v7 as uuidv7 } from "uuid";
import type {
  MagentaToScript,
  ScriptMeta,
  ScriptToMagenta,
  Result as SdkResult,
} from "../../sdk/protocol.ts";
import {
  escalateToSigkill,
  terminateProcess,
} from "../capabilities/shell-utils.ts";
import type { Chat } from "../chat/chat.ts";
import { notifyUser } from "../chat/notify.ts";
import type { SandboxRoot } from "../chat/thread.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { openFileInNonMagentaWindow } from "../nvim/openFileInNonMagentaWindow.ts";
import type { MagentaOptions } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Dispatch } from "../tea/tea.ts";
import { d, type VDOMNode, withBindings, withError } from "../tea/view.ts";
import {
  type AbsFilePath,
  expandTilde,
  type HomeDir,
  type NvimCwd,
} from "../utils/files.ts";

export type ScriptInvocationId = string & { __scriptInvocationId: true };

export type Msg =
  | { type: "catalog-updated" }
  | { type: "invocation-updated"; id: ScriptInvocationId }
  | { type: "toggle-invocation-expand"; id: ScriptInvocationId }
  | { type: "toggle-thread-yield"; id: ThreadId }
  | { type: "toggle-invocation-sandbox"; id: ScriptInvocationId }
  | { type: "abort-invocation"; id: ScriptInvocationId }
  | { type: "delete-invocation"; id: ScriptInvocationId }
  | { type: "set-invocation-title"; id: ScriptInvocationId; title: string };

export type ScriptMsg = {
  type: "script-msg";
  msg: Msg;
};

export type ScriptInvocationStatus = "running" | "done" | "error" | "aborted";

export type ScriptInvocationEntry =
  | { type: "log"; message: string }
  | { type: "thread"; threadId: ThreadId };

export type ScriptInvocation = {
  id: ScriptInvocationId;
  scriptName: string;
  title?: string;
  file: string;
  parameters: unknown;
  status: ScriptInvocationStatus;
  logs: string[];
  threadIds: ThreadId[];
  entries: ScriptInvocationEntry[];
  sandboxBypassed: boolean;
  child: ChildProcess;
  pendingThreads: Map<number, ThreadId>;
};

const REGISTRATION_TIMEOUT_MS = 5000;
const SIGKILL_GRACE_MS = 2000;

export class ScriptManager {
  private catalog: Map<string, { file: string; meta: ScriptMeta }> = new Map();
  public invocations: Map<ScriptInvocationId, ScriptInvocation> = new Map();
  private expandedInvocations: Set<ScriptInvocationId> = new Set();
  private expandedThreads: Set<ThreadId> = new Set();
  private myDispatch: Dispatch<Msg>;

  constructor(
    private context: {
      dispatch: Dispatch<RootMsg>;
      chat: Chat;
      nvim: Nvim;
      cwd: NvimCwd;
      homeDir: HomeDir;
      getScriptsPaths: () => string[];
      getOptions: () => MagentaOptions;
    },
  ) {
    this.myDispatch = (msg) =>
      this.context.dispatch({ type: "script-msg", msg });
  }

  update(msg: RootMsg): void {
    // Most state is mutated directly as IPC events arrive; script-msg dispatches
    // exist mainly to trigger a re-render through the central loop. Expand and
    // sandbox-toggle messages are the exception: they mutate state here.
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
      case "toggle-invocation-sandbox": {
        this.toggleInvocationSandbox(msg.msg.id);
        return;
      }
      case "abort-invocation":
        this.abortInvocation(msg.msg.id);
        return;
      case "delete-invocation":
        this.deleteInvocation(msg.msg.id);
        return;
      case "set-invocation-title": {
        const inv = this.invocations.get(msg.msg.id);
        if (inv) inv.title = msg.msg.title;
        return;
      }
      case "catalog-updated":
      case "invocation-updated":
        return;
    }
  }

  getCatalog(): ScriptMeta[] {
    return [...this.catalog.values()].map((c) => c.meta);
  }

  getScriptCatalog(): ScriptCatalogEntry[] {
    return [...this.catalog.values()].map((c) => ({
      ...c.meta,
      file: c.file,
    }));
  }

  private fork(file: string): ChildProcess {
    return spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--experimental-transform-types",
        file,
      ],
      {
        stdio: ["inherit", "inherit", "inherit", "ipc"],
        detached: true,
        env: { ...process.env, MAGENTA_SDK_CHILD: "1" },
      },
    );
  }

  /**
   * Resolve the configured `scriptsPaths` to absolute directories, expanding
   * `~` and resolving relative entries against the cwd. Later paths take
   * precedence on name collisions (project scripts override global ones), so we
   * order earlier entries first and let `discover()` overwrite as it goes.
   */
  private resolveScriptsDirs(): string[] {
    const seen = new Set<string>();
    const dirs: string[] = [];
    for (const entry of this.context.getScriptsPaths()) {
      const expanded = expandTilde(entry, this.context.homeDir);
      const abs = path.resolve(this.context.cwd, expanded);
      if (seen.has(abs)) continue;
      seen.add(abs);
      dirs.push(abs);
    }
    return dirs;
  }

  async discover(): Promise<void> {
    // Yield off the synchronous construction stack: discover() is kicked off
    // from the Magenta constructor, and dispatching `catalog-updated` before
    // construction finishes would touch not-yet-assigned fields (bufferManager).
    await Promise.resolve();
    this.catalog.clear();
    for (const dir of this.resolveScriptsDirs()) {
      if (!existsSync(dir)) continue;

      // Each scripts directory holds independent script installations, one per
      // subdirectory, with a single `index.ts` entry point. That file is
      // responsible for importing every script module so all `registerScript`
      // calls run. Other `.ts` files (shared libs, individual script modules)
      // are never forked directly, which keeps discovery and thread creation
      // predictable.
      let entries: { name: string; isDir: boolean }[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({
          name: e.name,
          isDir: e.isDirectory(),
        }));
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDir) continue;
        const indexFile = path.join(dir, entry.name, "index.ts");
        if (!existsSync(indexFile)) continue;

        const metas = await this.captureRegistration(indexFile);
        for (const meta of metas) {
          this.catalog.set(meta.name, { file: indexFile, meta });
        }
      }
    }
    this.myDispatch({ type: "catalog-updated" });
  }

  private captureRegistration(file: string): Promise<ScriptMeta[]> {
    return new Promise((resolve) => {
      const child = this.fork(file);
      const timeout = setTimeout(() => {
        terminateProcess(child);
        resolve([]);
      }, REGISTRATION_TIMEOUT_MS);
      child.once("message", (raw) => {
        const msg = raw as ScriptToMagenta;
        clearTimeout(timeout);
        terminateProcess(child);
        resolve(msg.type === "register" ? msg.scripts : []);
      });
      child.once("error", () => {
        clearTimeout(timeout);
        resolve([]);
      });
      // A file that never registers a script (e.g. a shared library module
      // alongside the scripts) exits without sending a message. Resolve
      // immediately on exit rather than waiting out the registration timeout.
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve([]);
      });
    });
  }

  runScript(
    scriptName: string,
    parameters: unknown,
    opts: { sandboxBypassed: boolean },
  ): ScriptInvocationId {
    const entry = this.catalog.get(scriptName);
    if (!entry) {
      throw new Error(`unknown script ${scriptName}`);
    }

    const id = uuidv7() as ScriptInvocationId;
    const child = this.fork(entry.file);
    const invocation: ScriptInvocation = {
      id,
      scriptName,
      file: entry.file,
      parameters,
      status: "running",
      logs: [],
      threadIds: [],
      entries: [],
      sandboxBypassed: opts.sandboxBypassed,
      child,
      pendingThreads: new Map(),
    };
    this.invocations.set(id, invocation);

    child.on("message", (raw) => {
      this.handleChildMessage(id, raw as ScriptToMagenta);
    });
    child.on("exit", () => this.handleChildExit(id));

    this.context.chat
      .generateScriptTitle(scriptName, entry.meta.description, parameters)
      .then((title) => {
        if (title) {
          this.myDispatch({ type: "set-invocation-title", id, title });
        }
      })
      .catch((e: unknown) => {
        this.context.nvim.logger.error(
          `Failed to generate script title: ${e instanceof Error ? e.message : String(e)}`,
        );
      });

    this.myDispatch({ type: "invocation-updated", id });
    return id;
  }

  private abortInvocation(id: ScriptInvocationId): void {
    const invocation = this.invocations.get(id);
    if (!invocation) return;
    if (invocation.status === "running") {
      invocation.status = "aborted";
    }
    for (const threadId of invocation.threadIds) {
      this.context.dispatch({
        type: "thread-msg",
        id: threadId,
        msg: { type: "abort" },
      });
    }
    this.terminateInvocation(id);
    this.myDispatch({ type: "invocation-updated", id });
  }

  private deleteInvocation(id: ScriptInvocationId): void {
    const invocation = this.invocations.get(id);
    if (!invocation) return;
    this.abortInvocation(id);
    for (const threadId of invocation.threadIds) {
      this.context.dispatch({
        type: "chat-msg",
        msg: { type: "delete-thread-subtree", id: threadId },
      });
    }
    this.invocations.delete(id);
    this.expandedInvocations.delete(id);
    this.myDispatch({ type: "catalog-updated" });
  }

  private send(invocation: ScriptInvocation, msg: MagentaToScript): void {
    invocation.child.send(msg);
  }

  private toggleInvocationSandbox(id: ScriptInvocationId): void {
    const inv = this.invocations.get(id);
    if (!inv) return;
    inv.sandboxBypassed = !inv.sandboxBypassed;
    if (inv.sandboxBypassed) {
      for (const entry of inv.entries) {
        if (entry.type === "thread") {
          this.context.chat.approveAllPendingInSubtree(entry.threadId);
        }
      }
    }
  }

  private getSandboxRoot(id: ScriptInvocationId): SandboxRoot | undefined {
    const invocation = this.invocations.get(id);
    if (!invocation) return undefined;
    return {
      get isSandboxBypassed() {
        return invocation.sandboxBypassed;
      },
      toggle: () => {
        this.toggleInvocationSandbox(id);
        this.myDispatch({ type: "invocation-updated", id });
      },
    };
  }

  private handleChildMessage(
    id: ScriptInvocationId,
    msg: ScriptToMagenta,
  ): void {
    const invocation = this.invocations.get(id);
    if (!invocation) return;

    switch (msg.type) {
      case "register":
        this.send(invocation, {
          type: "run-script",
          scriptName: invocation.scriptName,
          parameters: invocation.parameters,
        });
        return;

      case "log":
        invocation.logs.push(msg.message);
        invocation.entries.push({ type: "log", message: msg.message });
        this.myDispatch({ type: "invocation-updated", id });
        return;

      case "create-thread": {
        const requestId = msg.requestId;
        const options = msg.options;
        this.context.chat
          .spawnScriptThread({
            scriptInvocationId: id,
            prompt: msg.prompt,
            yieldSchema: msg.yieldSchema as JSONSchemaType,
            getSandboxRoot: () => this.getSandboxRoot(id),
            ...(options?.cwd ? { cwd: options.cwd } : {}),
            ...(options?.contextFiles
              ? { contextFiles: options.contextFiles }
              : {}),
            ...(options?.systemReminder
              ? { systemReminder: options.systemReminder }
              : {}),
            ...(options?.autoCompactThreshold !== undefined
              ? { autoCompactThreshold: options.autoCompactThreshold }
              : {}),
            ...(options?.autoCompactPrompt !== undefined
              ? { autoCompactPrompt: options.autoCompactPrompt }
              : {}),
          })
          .then((threadId) => {
            invocation.threadIds.push(threadId);
            invocation.entries.push({ type: "thread", threadId });
            invocation.pendingThreads.set(requestId, threadId);
            this.context.chat.onThreadYielded(threadId, () => {
              const result = this.context.chat.getThreadResult(threadId);
              if (result.status === "done") {
                this.resolveThread(id, requestId, result.result);
              }
            });
            this.myDispatch({ type: "invocation-updated", id });
          })
          .catch((err: unknown) => {
            this.send(invocation, {
              type: "thread-result",
              requestId,
              result: {
                status: "error",
                error: err instanceof Error ? err.message : String(err),
              },
            });
          });
        return;
      }

      case "done":
        invocation.status = "done";
        this.notifyFinished();
        this.myDispatch({ type: "invocation-updated", id });
        this.terminateInvocation(id);
        return;

      case "error":
        invocation.status = "error";
        this.notifyFinished();
        invocation.logs.push(`error: ${msg.message}`);
        invocation.entries.push({
          type: "log",
          message: `error: ${msg.message}`,
        });
        this.myDispatch({ type: "invocation-updated", id });
        this.terminateInvocation(id);
        return;
    }
  }

  private resolveThread(
    id: ScriptInvocationId,
    requestId: number,
    result:
      | { status: "ok"; value: string }
      | { status: "error"; error: string },
  ): void {
    const invocation = this.invocations.get(id);
    if (!invocation) return;
    if (!invocation.pendingThreads.has(requestId)) return;
    invocation.pendingThreads.delete(requestId);

    let sdkResult: SdkResult<unknown>;
    if (result.status === "ok") {
      let value: unknown;
      try {
        value = JSON.parse(result.value);
      } catch {
        value = result.value;
      }
      sdkResult = { status: "ok", value };
    } else {
      sdkResult = { status: "error", error: result.error };
    }

    this.send(invocation, {
      type: "thread-result",
      requestId,
      result: sdkResult,
    });
  }

  private handleChildExit(id: ScriptInvocationId): void {
    const invocation = this.invocations.get(id);
    if (!invocation) return;
    if (invocation.status === "running") {
      invocation.status = "error";
      this.myDispatch({ type: "invocation-updated", id });
    }
  }

  private terminateInvocation(id: ScriptInvocationId): void {
    const invocation = this.invocations.get(id);
    if (!invocation) return;
    terminateProcess(invocation.child);
    const child = invocation.child;
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        escalateToSigkill(child);
      }
    }, SIGKILL_GRACE_MS);
  }

  terminateAll(): void {
    for (const id of this.invocations.keys()) {
      this.terminateInvocation(id);
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
    }).catch((e: Error) => this.context.nvim.logger.error(e.message));
  }

  private renderThreadYield(threadId: ThreadId): VDOMNode {
    const result = this.context.chat.getThreadResult(threadId);
    if (result.status !== "done") {
      return d``;
    }
    if (result.result.status === "ok") {
      return d`\n  ⮑ yielded: ${result.result.value}`;
    }
    return d`\n  ⮑ error: ${result.result.error}`;
  }

  view(): VDOMNode {
    if (this.invocations.size === 0) {
      return d``;
    }

    const rows: VDOMNode[] = [];
    const sortedInvocations = [...this.invocations.values()].sort((a, b) =>
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
