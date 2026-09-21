import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import { v7 as uuidv7 } from "uuid";
import type { AgentsMap } from "./agents/agents.ts";
import type { FileIO } from "./capabilities/file-io.ts";
import type { ScriptRunner } from "./capabilities/script-runner.ts";
import type {
  DockerSpawnConfig,
  ThreadManager,
} from "./capabilities/thread-manager.ts";
import type {
  ScriptInvocationId,
  SubagentConfig,
  ThreadId,
  ThreadType,
} from "./chat-types.ts";
import type { ThreadCompactor } from "./compaction/compactor.ts";
import { Emitter } from "./emitter.ts";
import type { ProviderProfile } from "./provider-options.ts";
import type {
  AgentInput,
  NativeMessageIdx,
  Provider,
} from "./providers/provider-types.ts";
import type { EnvironmentConfig, Thread, ThreadCallbacks } from "./thread.ts";
import type { ThreadResult } from "./thread-api.ts";
import {
  assembleThread,
  type ChatThreadPolicy,
  type PreparedThreadContext,
  type ThreadInitialization,
} from "./thread-assembly.ts";
import * as ThreadTitle from "./tools/thread-title.ts";
import { Defer } from "./utils/async.ts";
import type { NvimCwd, UnresolvedFilePath } from "./utils/files.ts";

export type SessionId = string & { __sessionId: true };

/** Everything the session needs to know about a thread it owns. Host-specific
 * collaborators are not here: they are prepared per thread by the host and
 * keyed by thread id there. */
export type SessionCreateOptions = {
  threadId?: ThreadId;
  profile: ProviderProfile;
  threadType: ThreadType;
  parent?: ThreadId;
  contextFiles?: UnresolvedFilePath[];
  /** Bootstrap content the session submits itself, with no view involved. */
  inputMessages?: AgentInput[];
  subagentConfig?: SubagentConfig;
  fileIO?: FileIO;
  environmentConfig?: EnvironmentConfig;
  dockerSpawnConfig?: DockerSpawnConfig | undefined;
  yieldSchema?: JSONSchemaType;
  scriptInvocationId?: ScriptInvocationId;
  scriptName?: string;
  label?: string;
  autoCompactThreshold?: number;
  autoCompactPrompt?: string;
};

/** What the host is asked to prepare: a fresh thread, or a fork frozen at an
 * index of a source thread this session owns. */
export type ThreadPreparation = {
  options: SessionCreateOptions & { threadId: ThreadId };
} & (
  | { type: "fresh" }
  | { type: "fork"; source: Thread; nativeMessageIdx: NativeMessageIdx }
);

export type PreparedThread = {
  context: PreparedThreadContext;
  /** Host-resolved option defaults; per-thread overrides win over these. */
  autoCompactThreshold?: number;
  autoCompactPrompt: string;
  /** Where the conversation archive is written. Tests point this at a scratch
   * directory instead of the user's archive. */
  archiveBaseDir?: string;
  /** Release only the resources this preparation acquired. */
  release?: () => Promise<void>;
};

export interface SessionHost {
  getActiveProfile(): ProviderProfile;
  getAgents?(): AgentsMap;
  getProvider?(profile: ProviderProfile): Provider;
  /** Drop approvals that belong to work being abandoned. */
  rejectApprovals?(id: ThreadId): void;
  prepareThread(
    request: ThreadPreparation,
    session: Session,
    signal: AbortSignal,
  ): Promise<PreparedThread>;
}

export type SessionThread = {
  id: ThreadId;
  parentThreadId: ThreadId | undefined;
  scriptInvocationId?: ScriptInvocationId;
  lastActivityTime: number;
  /** Retained so child profile/environment derivation and forking read session
   * state rather than a view wrapper. */
  options: SessionCreateOptions;
} & (
  | { state: "pending" }
  | { state: "error"; error: Error }
  | {
      state: "initialized";
      thread: Thread;
      compactor: ThreadCompactor | undefined;
    }
);

type SessionEvents = {
  /** Invalidation: the record for this id may have changed in any way. */
  changed: [id: ThreadId];
  removed: [id: ThreadId];
};

/** The authoritative thread registry: identity, hierarchy, construction
 * policy, lifecycle results and teardown for one implicit session. Views are
 * observers; execution never depends on one being attached. */
export class Session extends Emitter<SessionEvents> implements ThreadManager {
  readonly id: SessionId = uuidv7() as SessionId;
  private records = new Map<ThreadId, SessionThread>();
  /** Retained for known ids (including deleted ones) until disposal, so a late
   * `awaitThreadResult` settles instead of hanging. */
  private results = new Map<ThreadId, Defer<ThreadResult>>();
  private pending = new Map<ThreadId, AbortController>();
  private releases = new Map<ThreadId, () => Promise<void>>();
  private cleanup = new Set<Promise<unknown>>();
  private disposed = false;
  private disposal: Promise<void> | undefined;
  /** Docker teardown progress. The core has no opinion about containers, so
   * the message a supervisor reports lives with the session that owns them. */
  readonly teardownMessages = new Map<ThreadId, string>();
  /** Late-bound so scripts can be wired after construction, before any thread
   * exists. */
  scriptRunner: ScriptRunner | undefined;

  constructor(private host: SessionHost) {
    super();
  }

  getThread(id: ThreadId): Readonly<SessionThread> | undefined {
    return this.records.get(id);
  }

  listThreads(): readonly Readonly<SessionThread>[] {
    return [...this.records.values()];
  }

  getRootAncestorId(id: ThreadId): ThreadId {
    let parent = this.records.get(id)?.parentThreadId;
    while (parent) {
      id = parent;
      parent = this.records.get(id)?.parentThreadId;
    }
    return id;
  }

  /** Note activity a view observed (a submission, a finished turn, a pending
   * approval). Activity time is session state; observers do not mutate it. */
  recordActivity(id: ThreadId): void {
    const record = this.records.get(id);
    if (!record) return;
    record.lastActivityTime = Date.now();
    this.emit("changed", id);
  }

  buildChildrenMap(): Map<ThreadId, ThreadId[]> {
    const map = new Map<ThreadId, ThreadId[]>();
    for (const record of this.records.values()) {
      if (record.parentThreadId === undefined) continue;
      map.set(record.parentThreadId, [
        ...(map.get(record.parentThreadId) ?? []),
        record.id,
      ]);
    }
    return map;
  }

  /** Asynchronous work disposal has to drain. */
  private track<T>(promise: Promise<T>): Promise<T> {
    this.cleanup.add(promise);
    void promise
      .catch(() => {})
      .finally(() => this.cleanup.delete(promise as Promise<unknown>));
    return promise;
  }

  createThread(options: SessionCreateOptions): Promise<ThreadId> {
    return this.track(
      this.create({
        type: "fresh",
        options: {
          ...options,
          threadId: options.threadId ?? (uuidv7() as ThreadId),
        },
      }),
    );
  }

  createRootThread(): Promise<ThreadId> {
    return this.createThread({
      profile: this.host.getActiveProfile(),
      threadType: "root",
    });
  }

  createAgentThread(agentName: string): Promise<ThreadId> {
    const agents = this.host.getAgents?.() ?? {};
    const agent = agents[agentName];
    if (!agent) {
      throw new Error(
        `Agent "${agentName}" not found. Available agents: ${Object.keys(agents).join(", ")}`,
      );
    }
    return this.createThread({
      profile: this.host.getActiveProfile(),
      threadType: "root",
      subagentConfig: {
        agentName: agent.name,
        systemPrompt: agent.systemPrompt,
        systemReminder: agent.systemReminder,
        tier: agent.tier,
      },
    });
  }

  /** A script-owned thread: same registry, plus the invocation it belongs to
   * and the yield schema its result must satisfy. */
  spawnScriptThread(opts: {
    threadId?: ThreadId;
    scriptInvocationId: ScriptInvocationId;
    scriptName: string;
    prompt: string;
    yieldSchema: JSONSchemaType;
    profile?: ProviderProfile;
    cwd?: NvimCwd;
    contextFiles?: UnresolvedFilePath[];
    systemReminder?: string;
    autoCompactThreshold?: number;
    autoCompactPrompt?: string;
  }): Promise<ThreadId> {
    const { contextFiles: _contextFiles, prompt: _prompt, ...rest } = opts;
    return this.createThread({
      ...rest,
      profile: opts.profile ?? this.host.getActiveProfile(),
      threadType: "subagent",
      environmentConfig: {
        type: "local",
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      },
      ...(opts.contextFiles ? { contextFiles: opts.contextFiles } : {}),
      ...(opts.systemReminder
        ? { subagentConfig: { systemReminder: opts.systemReminder } }
        : {}),
      inputMessages: [
        {
          type: "text",
          text: opts.prompt,
        },
      ],
    });
  }

  /** Generate a concise title for a script invocation, mirroring how thread
   * titles are generated: a fast-model forced tool-use call. */
  async generateScriptTitle(
    scriptName: string,
    description: string,
    parameters: unknown,
  ): Promise<string | undefined> {
    const profile = this.host.getActiveProfile();
    if (!this.host.getProvider) {
      throw new Error("No title provider configured");
    }
    const result = await this.host.getProvider(profile).forceToolUse({
      model: profile.fastModel,
      input: [
        {
          type: "text",
          text: `\
A script has been invoked. Come up with a succinct title describing this specific invocation.

Script name: ${scriptName}
Description: ${description}
Parameters: ${JSON.stringify(parameters)}

The title must be a single line (no newlines) and a few words long (ideally around 40 characters or fewer).`,
        },
      ],
      spec: ThreadTitle.spec,
      disableCaching: true,
    }).promise;
    if (result.toolRequest.status === "ok") {
      const input = ThreadTitle.validateInput(
        result.toolRequest.value.input as { [key: string]: unknown },
      );
      if (input.status === "ok") return input.value.title;
    }
    return undefined;
  }

  private async create(request: ThreadPreparation): Promise<ThreadId> {
    const { options } = request;
    const id = options.threadId;
    if (this.disposed) throw new Error("Session disposed");
    if (this.results.has(id)) throw new Error(`Thread ${id} already exists`);
    if (options.parent && !this.records.has(options.parent)) {
      throw new Error(`Parent thread ${options.parent} not available`);
    }

    // The id and its record exist before any asynchronous preparation, so a
    // deletion that lands mid-flight has something to invalidate.
    const controller = new AbortController();
    this.pending.set(id, controller);
    const record: SessionThread = {
      id,
      state: "pending",
      parentThreadId: options.parent,
      ...(options.scriptInvocationId
        ? { scriptInvocationId: options.scriptInvocationId }
        : {}),
      lastActivityTime: Date.now(),
      options,
    };
    this.records.set(id, record);
    this.results.set(id, new Defer());
    this.emit("changed", id);

    let prepared: PreparedThread | undefined;
    let thread: Thread | undefined;
    let releaseRegistered = false;
    try {
      prepared = await this.host.prepareThread(
        request,
        this,
        controller.signal,
      );
      if (controller.signal.aborted || this.records.get(id) !== record) {
        throw new Error("Thread creation cancelled");
      }

      const current = () =>
        !controller.signal.aborted &&
        this.records.get(id)?.state === "initialized";
      const callbacks: ThreadCallbacks = {
        onUpdate: () => {
          const entry = this.records.get(id);
          if (!current() || !entry) return;
          entry.lastActivityTime = Date.now();
          this.emit("changed", id);
        },
      };

      const assembled = assembleThread({
        id,
        initialization: this.initialization(request, prepared),
        context: { ...prepared.context, threadManager: this },
        callbacks,
      });
      thread = assembled.thread;
      if (options.label) thread.setTitle(options.label);
      if (prepared.release) {
        this.releases.set(id, prepared.release);
        releaseRegistered = true;
      }
      this.records.set(id, {
        ...record,
        state: "initialized",
        // The environment the host actually resolved is what children inherit,
        // not the (possibly absent) request.
        options: {
          ...options,
          environmentConfig: prepared.context.environmentConfig,
        },
        thread,
        compactor: assembled.compactor,
      });
      thread.result.then(
        (result) => {
          this.teardownMessages.delete(id);
          this.results.get(id)?.resolve(result);
        },
        (error: unknown) =>
          this.results
            .get(id)
            ?.resolve({ type: "aborted", reason: String(error) }),
      );
      this.emit("changed", id);

      if (options.contextFiles?.length) {
        await thread.contextFiles.addFiles(options.contextFiles);
      }
      if (!current()) throw new Error("Thread creation cancelled");

      if (options.inputMessages) {
        void thread
          .submit({ type: "resolved", messages: options.inputMessages })
          .catch((error: unknown) =>
            prepared?.context.logger.error(String(error)),
          );
      }
      return id;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (this.records.get(id) === record && !controller.signal.aborted) {
        this.records.set(id, { ...record, state: "error", error: failure });
        this.results
          .get(id)
          ?.resolve({ type: "aborted", reason: failure.message });
        this.emit("changed", id);
      }
      try {
        // A thread that never made it into the registry (or whose record was
        // deleted while we were finishing) must not be left running.
        if (
          thread &&
          !thread.isDestroyed &&
          this.records.get(id)?.state !== "initialized"
        ) {
          await thread.destroy();
        }
      } finally {
        if (releaseRegistered) {
          const release = this.releases.get(id);
          this.releases.delete(id);
          await release?.();
        } else {
          await prepared?.release?.();
        }
      }
      throw failure;
    } finally {
      this.pending.delete(id);
    }
  }

  private initialization(
    request: ThreadPreparation,
    prepared: PreparedThread,
  ): ThreadInitialization {
    const { options } = request;
    if (request.type === "fork") {
      return {
        type: "fork",
        sourceThread: request.source,
        nativeMessageIdx: request.nativeMessageIdx,
      };
    }
    const archive = {
      ...(options.scriptName ? { scriptName: options.scriptName } : {}),
      ...(prepared.archiveBaseDir ? { baseDir: prepared.archiveBaseDir } : {}),
    };
    const archiveOptions = Object.keys(archive).length
      ? { archiveOptions: archive }
      : {};
    if (options.threadType === "compact") {
      return { type: "fresh", threadType: "compact", ...archiveOptions };
    }
    const threshold =
      options.autoCompactThreshold ?? prepared.autoCompactThreshold;
    const policy: ChatThreadPolicy = {
      ...(options.dockerSpawnConfig
        ? {
            docker: {
              ...options.dockerSpawnConfig,
              onProgress: (message: string) => {
                if (!this.records.has(options.threadId)) return;
                this.teardownMessages.set(options.threadId, message);
                this.emit("changed", options.threadId);
              },
            },
          }
        : {}),
      ...(threshold !== undefined ? { autoCompactThreshold: threshold } : {}),
      autoCompactPrompt:
        options.autoCompactPrompt ?? prepared.autoCompactPrompt,
    };
    return {
      type: "fresh",
      threadType: options.threadType,
      ...archiveOptions,
      policy,
    };
  }

  /** Fork a thread this session owns. The index is captured now; the clone
   * truncates to it, so preparation racing ahead cannot widen the snapshot. */
  forkThread(
    sourceThreadId: ThreadId,
    nativeMessageIdx?: NativeMessageIdx,
  ): Promise<ThreadId> {
    const source = this.records.get(sourceThreadId);
    if (source?.state !== "initialized") {
      throw new Error(`Thread ${sourceThreadId} not available for forking`);
    }
    if (source.options.environmentConfig?.type === "docker") {
      throw new Error(
        `Session.forkThread only supports local-source forks for MVP. Docker-source forks are a follow-up.`,
      );
    }
    const {
      parent: _parent,
      inputMessages: _inputMessages,
      contextFiles: _contextFiles,
      label: _label,
      ...options
    } = source.options;
    const index = nativeMessageIdx ?? source.thread.nativeMessageIdx;
    return this.track(
      this.create({
        type: "fork",
        options: { ...options, threadId: uuidv7() as ThreadId },
        source: source.thread,
        nativeMessageIdx: index,
      }),
    );
  }

  async spawnThread(
    opts: Parameters<ThreadManager["spawnThread"]>[0],
  ): Promise<ThreadId> {
    const parent = this.records.get(opts.parentThreadId);
    if (parent?.state !== "initialized") {
      throw new Error(`Parent thread ${opts.parentThreadId} not available`);
    }
    const base = parent.options.profile;
    const profile: ProviderProfile = opts.subagentConfig?.fastModel
      ? {
          ...base,
          model: base.fastModel,
          thinking: undefined,
          reasoning: undefined,
        }
      : opts.subagentConfig?.thinkingModel
        ? { ...base, model: base.thinkingModel }
        : base;
    const environmentConfig: EnvironmentConfig = opts.dockerSpawnConfig
      ? {
          type: "docker",
          container: opts.dockerSpawnConfig.containerName,
          cwd: opts.dockerSpawnConfig.workspacePath,
        }
      : opts.cwd
        ? { type: "local", cwd: opts.cwd }
        : (parent.options.environmentConfig ?? { type: "local" });
    const { prompt: _prompt, parentThreadId: _parentThreadId, ...rest } = opts;
    return this.createThread({
      ...rest,
      profile,
      parent: opts.parentThreadId,
      environmentConfig,
      inputMessages: [
        {
          type: "text",
          text: opts.prompt,
        },
      ],
    });
  }

  /** Invalidate a creation that has not registered a thread yet. */
  private abortPending(id: ThreadId): void {
    const record = this.records.get(id);
    if (record?.state !== "pending") return;
    this.pending.get(id)?.abort();
    const error = new Error("Thread creation aborted");
    this.records.set(id, { ...record, state: "error", error });
    this.results.get(id)?.resolve({ type: "aborted", reason: error.message });
    this.emit("changed", id);
  }

  /** Abort a thread and its descendants. Only the requested thread's unsent
   * input is returned; a descendant's input is not the caller's to restore. */
  async abortThread(id: ThreadId): ReturnType<Thread["abort"]> {
    const children = this.buildChildrenMap();
    // Every abort is issued before the first await, so a caller that dispatched
    // an abort can observe the request having landed synchronously.
    const start = (target: ThreadId) => {
      this.abortPending(target);
      this.host.rejectApprovals?.(target);
      const entry = this.records.get(target);
      return entry?.state === "initialized" && !entry.thread.yielded
        ? entry.thread.abort()
        : undefined;
    };
    const own = start(id);
    const descendants: Promise<unknown>[] = [];
    const startSubtree = (target: ThreadId) => {
      const aborting = start(target);
      if (aborting) descendants.push(aborting);
      for (const child of children.get(target) ?? []) startSubtree(child);
    };
    for (const child of children.get(id) ?? []) startSubtree(child);
    await Promise.all(descendants);
    return (await own) ?? { unsent: [] };
  }

  deleteThread(id: ThreadId): void {
    for (const child of this.buildChildrenMap().get(id) ?? []) {
      this.deleteThread(child);
    }
    const record = this.records.get(id);
    if (!record) return;
    // Detach synchronously: a preparation still in flight can no longer
    // register or submit, and its result is released asynchronously below.
    this.pending.get(id)?.abort();
    this.pending.delete(id);
    this.host.rejectApprovals?.(id);
    this.records.delete(id);
    this.results
      .get(id)
      ?.resolve({ type: "aborted", reason: "thread deleted" });
    this.teardownMessages.delete(id);
    const release = this.releases.get(id);
    this.releases.delete(id);
    void this.track(
      (async () => {
        try {
          if (record.state === "initialized") await record.thread.destroy();
        } finally {
          await release?.();
        }
      })(),
    ).catch(() => {});
    this.emit("removed", id);
  }

  awaitThreadResult(id: ThreadId): Promise<ThreadResult> {
    const result = this.results.get(id);
    if (!result) {
      return Promise.reject(new Error(`Unknown thread ${id}`));
    }
    return result.promise;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    for (const id of [...this.records.keys()]) this.deleteThread(id);
    this.disposal = (async () => {
      while (this.cleanup.size) await Promise.allSettled([...this.cleanup]);
      this.removeAllListeners();
    })();
    return this.disposal;
  }
}
