import { type ChildProcess, spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import { v7 as uuidv7 } from "uuid";
import type { ScriptCatalogEntry } from "../capabilities/script-runner.ts";
import type { ScriptInvocationId, ThreadId } from "../chat-types.ts";
import { Emitter } from "../emitter.ts";
import type { Logger } from "../logger.ts";
import type { Session } from "../session.ts";
import type { ThreadResult } from "../thread-api.ts";
import type { HomeDir, NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import { expandTilde } from "../utils/files.ts";
import { escalateToSigkill, terminateProcess } from "../utils/process.ts";
import type {
  MagentaToScript,
  ScriptMeta,
  ScriptToMagenta,
  Result as SdkResult,
} from "./protocol.ts";

const MANIFEST_FILENAME = ".magenta-manifest.json";
const REGISTRATION_TIMEOUT_MS = 5000;
const SIGKILL_GRACE_MS = 2000;

export type ScriptInvocationStatus = "running" | "done" | "error" | "aborted";

export type ScriptInvocationEntry =
  | { type: "log"; message: string }
  | { type: "thread"; threadId: ThreadId };

/** The publicly observable state of an invocation. Child process handles and
 * in-flight IPC requests are private execution state and stay out of it. */
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
};

export type ScriptThreadResult =
  | { status: "ok"; value: string }
  | { status: "error"; error: string };

/** Bypass state of an invocation, as the rest of the system observes it. */
export type ScriptSandboxRoot = {
  readonly isSandboxBypassed: boolean;
  toggle?: () => void;
};

/** Approval routing the script manager cannot own: whether a triggering thread
 * runs bypassed, and where an invocation's bypass state is published. */
export interface ScriptSandboxCapability {
  isThreadBypassed(threadId: ThreadId): boolean;
  registerSandboxRoot(
    threadId: ThreadId,
    getSandboxRoot: () => ScriptSandboxRoot | undefined,
  ): void;
  approveAllPendingInSubtree(threadId: ThreadId): void;
}

type ScriptManagerEvents = {
  catalogChanged: [];
  invocationChanged: [id: ScriptInvocationId];
  invocationRemoved: [id: ScriptInvocationId];
  /** The invocation reached a terminal state; the client may notify the user. */
  invocationFinished: [id: ScriptInvocationId];
};

/** Private per-invocation execution state. */
type Execution = {
  child: ChildProcess;
  pendingThreads: Map<number, ThreadId>;
};

/**
 * Newest mtime among the script directory's own sources. `node_modules` is
 * skipped: it dwarfs the rest of the tree and changes only on installs, which
 * touch `package.json` anyway.
 */
function newestSourceMtime(dir: string): number {
  let newest = 0;
  const walk = (current: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === MANIFEST_FILENAME) {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        newest = Math.max(newest, statSync(full).mtimeMs);
      } catch {
        // raced with a delete; ignore
      }
    }
  };
  walk(dir);
  return newest;
}

/** A thread's outcome as the script SDK sees it. A structured yield is
 * stringified here, at the display/transport edge, rather than by the thread
 * itself. */
function toScriptResult(result: ThreadResult): ScriptThreadResult {
  if (result.type === "aborted") {
    return { status: "error", error: result.reason };
  }
  return { status: "ok", value: JSON.stringify(result.value) };
}

/**
 * Session-owned script orchestration: catalog discovery, child-process launch
 * and IPC, invocation lifecycle, titles, and the threads an invocation owns.
 * Clients observe it; they never drive it.
 */
export class ScriptManager extends Emitter<ScriptManagerEvents> {
  private catalog = new Map<string, { file: string; meta: ScriptMeta }>();
  /** Live invocation state, observable by clients; child processes and
   * in-flight IPC requests stay private. */
  readonly invocations = new Map<ScriptInvocationId, ScriptInvocation>();
  private executions = new Map<ScriptInvocationId, Execution>();
  /** A thread's settled outcome, kept for rendering: a promise cannot be read
   * synchronously by a view. */
  private threadYields = new Map<ThreadId, ScriptThreadResult>();
  private disposed = false;

  constructor(
    private context: {
      session: Session;
      logger: Logger;
      cwd: NvimCwd;
      homeDir: HomeDir;
      getScriptsPaths: () => string[];
      sandbox: ScriptSandboxCapability;
    },
  ) {
    super();
  }

  getCatalog(): ScriptMeta[] {
    return [...this.catalog.values()].map((c) => c.meta);
  }

  getScriptCatalog(): ScriptCatalogEntry[] {
    return [...this.catalog.values()].map((c) => ({ ...c.meta, file: c.file }));
  }

  getInvocation(id: ScriptInvocationId): ScriptInvocation | undefined {
    return this.invocations.get(id);
  }

  listInvocations(): ScriptInvocation[] {
    return [...this.invocations.values()];
  }

  /** The invocation's child process id. Execution state is otherwise private;
   * this exists so termination behavior can be asserted. */
  childPid(id: ScriptInvocationId): number | undefined {
    return this.executions.get(id)?.child.pid;
  }

  getThreadYield(threadId: ThreadId): ScriptThreadResult | undefined {
    return this.threadYields.get(threadId);
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
    // from the owner's constructor, and emitting `catalogChanged` before
    // construction finishes would touch not-yet-assigned fields.
    await Promise.resolve();
    if (this.disposed) return;
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

        const metas = await this.loadRegistration(
          path.join(dir, entry.name),
          indexFile,
        );
        for (const meta of metas) {
          this.catalog.set(meta.name, { file: indexFile, meta });
        }
      }
    }
    this.emit("catalogChanged");
  }

  /**
   * Forking a script's `index.ts` to capture its `registerScript` calls costs a
   * full node startup (with TS transform) per script directory, and discovery
   * runs on every thread creation. Cache the captured metadata in a manifest
   * next to the script, keyed on the newest mtime of the directory's sources,
   * so the common case (scripts unchanged) is a handful of stat calls.
   */
  private async loadRegistration(
    scriptDir: string,
    indexFile: string,
  ): Promise<ScriptMeta[]> {
    const manifestFile = path.join(scriptDir, MANIFEST_FILENAME);
    const mtimeMs = newestSourceMtime(scriptDir);

    try {
      const cached = JSON.parse(readFileSync(manifestFile, "utf8")) as {
        mtimeMs: number;
        scripts: ScriptMeta[];
      };
      if (cached.mtimeMs === mtimeMs) return cached.scripts;
    } catch {
      // missing or corrupt manifest: fall through and re-capture
    }

    const scripts = await this.captureRegistration(indexFile);
    try {
      writeFileSync(manifestFile, JSON.stringify({ mtimeMs, scripts }));
    } catch (e) {
      this.context.logger.warn(
        `Failed to write script manifest ${manifestFile}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return scripts;
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

  /** The `run_script` capability: an agent-triggered invocation inherits the
   * triggering thread's bypass state and then outlives that thread. */
  runScript(opts: {
    scriptName: string;
    parameters: unknown;
    triggeringThreadId: ThreadId;
  }): void {
    this.startScript(opts.scriptName, opts.parameters, {
      sandboxBypassed: this.context.sandbox.isThreadBypassed(
        opts.triggeringThreadId,
      ),
    });
  }

  startScript(
    scriptName: string,
    parameters: unknown,
    opts: { sandboxBypassed: boolean },
  ): ScriptInvocationId {
    if (this.disposed) throw new Error("ScriptManager disposed");
    const entry = this.catalog.get(scriptName);
    if (!entry) {
      throw new Error(`unknown script ${scriptName}`);
    }

    const id = uuidv7() as ScriptInvocationId;
    const child = this.fork(entry.file);
    this.invocations.set(id, {
      id,
      scriptName,
      file: entry.file,
      parameters,
      status: "running",
      logs: [],
      threadIds: [],
      entries: [],
      sandboxBypassed: opts.sandboxBypassed,
    });
    this.executions.set(id, { child, pendingThreads: new Map() });

    child.on("message", (raw) => {
      this.handleChildMessage(id, raw as ScriptToMagenta);
    });
    child.on("exit", () => this.handleChildExit(id));

    this.context.session
      .generateScriptTitle(scriptName, entry.meta.description, parameters)
      .then((title) => {
        const invocation = this.invocations.get(id);
        // A late title must not resurrect a deleted invocation.
        if (!title || !invocation) return;
        invocation.title = title;
        this.emit("invocationChanged", id);
      })
      .catch((e: unknown) => {
        this.context.logger.error(
          `Failed to generate script title: ${e instanceof Error ? e.message : String(e)}`,
        );
      });

    this.emit("invocationChanged", id);
    return id;
  }

  abortInvocation(id: ScriptInvocationId): void {
    const invocation = this.invocations.get(id);
    if (!invocation) return;
    if (invocation.status === "running") {
      invocation.status = "aborted";
    }
    for (const threadId of invocation.threadIds) {
      void this.context.session.abortThread(threadId).catch(() => {});
    }
    this.terminateInvocation(id);
    this.emit("invocationChanged", id);
  }

  deleteInvocation(id: ScriptInvocationId): void {
    const invocation = this.invocations.get(id);
    if (!invocation) return;
    this.abortInvocation(id);
    for (const threadId of invocation.threadIds) {
      this.context.session.deleteThread(threadId);
      this.threadYields.delete(threadId);
    }
    this.invocations.delete(id);
    this.executions.delete(id);
    this.emit("invocationRemoved", id);
  }

  private send(id: ScriptInvocationId, msg: MagentaToScript): void {
    const execution = this.executions.get(id);
    if (!execution) return;
    const child = execution.child;
    // A terminated child's channel is gone; sending would throw.
    if (!child.connected) return;
    child.send(msg);
  }

  toggleInvocationSandbox(id: ScriptInvocationId): void {
    const inv = this.invocations.get(id);
    if (!inv) return;
    inv.sandboxBypassed = !inv.sandboxBypassed;
    if (inv.sandboxBypassed) {
      for (const threadId of inv.threadIds) {
        this.context.sandbox.approveAllPendingInSubtree(threadId);
      }
    }
    this.emit("invocationChanged", id);
  }

  private sandboxRoot(id: ScriptInvocationId): ScriptSandboxRoot | undefined {
    const invocation = this.invocations.get(id);
    if (!invocation) return undefined;
    return {
      get isSandboxBypassed() {
        return invocation.sandboxBypassed;
      },
      toggle: () => this.toggleInvocationSandbox(id),
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
        this.send(id, {
          type: "run-script",
          scriptName: invocation.scriptName,
          parameters: invocation.parameters,
        });
        return;

      case "log":
        invocation.logs.push(msg.message);
        invocation.entries.push({ type: "log", message: msg.message });
        this.emit("invocationChanged", id);
        return;

      case "create-thread":
        this.createScriptThread(id, msg);
        return;

      case "done":
        invocation.status = "done";
        this.emit("invocationChanged", id);
        this.emit("invocationFinished", id);
        this.terminateInvocation(id);
        return;

      case "error": {
        invocation.status = "error";
        invocation.logs.push(`error: ${msg.message}`);
        invocation.entries.push({
          type: "log",
          message: `error: ${msg.message}`,
        });
        this.emit("invocationChanged", id);
        this.emit("invocationFinished", id);
        this.terminateInvocation(id);
        return;
      }
    }
  }

  private createScriptThread(
    id: ScriptInvocationId,
    msg: Extract<ScriptToMagenta, { type: "create-thread" }>,
  ): void {
    const invocation = this.invocations.get(id);
    if (!invocation) return;
    const requestId = msg.requestId;
    const options = msg.options;
    // The bypass state of a script thread belongs to its invocation, so it is
    // published against the reserved id before creation starts.
    const threadId = uuidv7() as ThreadId;
    this.context.sandbox.registerSandboxRoot(threadId, () =>
      this.sandboxRoot(id),
    );
    this.context.session
      .spawnScriptThread({
        threadId,
        scriptInvocationId: id,
        scriptName: invocation.scriptName,
        prompt: msg.prompt,
        yieldSchema: msg.yieldSchema as JSONSchemaType,
        ...(options?.cwd ? { cwd: options.cwd as NvimCwd } : {}),
        ...(options?.contextFiles
          ? { contextFiles: options.contextFiles as UnresolvedFilePath[] }
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
      .then(() => {
        const execution = this.executions.get(id);
        const current = this.invocations.get(id);
        if (!execution || !current) {
          // The invocation was deleted while the thread was being prepared; it
          // must not leave an orphan running.
          this.context.session.deleteThread(threadId);
          return;
        }
        current.threadIds.push(threadId);
        current.entries.push({ type: "thread", threadId });
        execution.pendingThreads.set(requestId, threadId);
        void this.context.session
          .awaitThreadResult(threadId)
          .then((threadResult) => {
            const result = toScriptResult(threadResult);
            this.threadYields.set(threadId, result);
            this.resolveThread(id, requestId, result);
          })
          .catch(() => {});
        this.emit("invocationChanged", id);
      })
      .catch((err: unknown) => {
        this.send(id, {
          type: "thread-result",
          requestId,
          result: {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
          },
        });
      });
  }

  private resolveThread(
    id: ScriptInvocationId,
    requestId: number,
    result: ScriptThreadResult,
  ): void {
    const execution = this.executions.get(id);
    if (!execution) return;
    if (!execution.pendingThreads.has(requestId)) return;
    execution.pendingThreads.delete(requestId);

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

    this.send(id, { type: "thread-result", requestId, result: sdkResult });
  }

  private handleChildExit(id: ScriptInvocationId): void {
    const invocation = this.invocations.get(id);
    if (!invocation) return;
    if (invocation.status === "running") {
      invocation.status = "error";
      this.emit("invocationChanged", id);
    }
  }

  private terminateInvocation(id: ScriptInvocationId): void {
    const execution = this.executions.get(id);
    if (!execution) return;
    const child = execution.child;
    terminateProcess(child);
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

  dispose(): Promise<void> {
    this.disposed = true;
    this.terminateAll();
    this.invocations.clear();
    this.executions.clear();
    this.threadYields.clear();
    this.removeAllListeners();
    return Promise.resolve();
  }
}
