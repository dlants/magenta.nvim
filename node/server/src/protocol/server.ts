import type { ScriptInvocationId, ThreadId } from "../chat-types.ts";
import type { ScriptManager } from "../scripts/script-manager.ts";
import type { Session, SessionEvents, SessionId } from "../session.ts";
import { renderPending } from "../submission/index.ts";
import type { Thread } from "../thread.ts";
import { ABORTED, type Aborted } from "../thread-api.ts";
import type { ClientEffectHandler } from "./client.ts";
import type {
  Operation,
  OperationOf,
  OperationResultFor,
  OperationSuccessMap,
  OperationType,
} from "./operations.ts";
import {
  globalState,
  type ProtocolGlobalState,
  type ProtocolScriptState,
  type ProtocolSessionState,
  type ProtocolThreadState,
  scriptState,
  sessionState,
  submissionResult,
  threadState,
} from "./state.ts";

type TopicFields = {
  global: object;
  session: { sessionId: SessionId };
  script: { invocationId: ScriptInvocationId };
  thread: { threadId: ThreadId };
};
type StateMap = {
  global: ProtocolGlobalState;
  session: ProtocolSessionState;
  script: ProtocolScriptState;
  thread: ProtocolThreadState;
};
type TopicType = keyof StateMap;
type TopicOf<K extends TopicType> = { type: K } & TopicFields[K];

export type Topic = { [K in TopicType]: TopicOf<K> }[TopicType];
export type StateFor<T extends Topic> = StateMap[T["type"]];

export interface MagentaServer {
  /** Delivers the current state immediately and after every change
   * (coalesced per microtask). `undefined` means the target is gone; it is
   * delivered once and the subscription ends. */
  subscribe<K extends TopicType>(
    topic: TopicOf<K>,
    listener: (state: StateMap[K] | undefined) => void,
  ): () => void;
  /** The current state, or `undefined` if the target is gone or not ready. */
  getState<K extends TopicType>(topic: TopicOf<K>): StateMap[K] | undefined;
  execute<O extends Operation>(op: O): Promise<OperationResultFor<O>>;
  attachClient(client: ClientEffectHandler): void;
  detachClient(): void;
  dispose(): Promise<void>;
}

export type InProcessServerDeps = {
  session: Session;
  scripts?: ScriptManager;
};

/** Thrown for unknown ids; `execute` reports it as an error result. */
class UnknownTarget extends Error {}

/** Projected state for a topic: a value, `undefined` once gone, or `waiting`
 * while a thread is still being created (nothing to deliver yet). */
type Projection<S> = S | undefined | "waiting";

export function createInProcessServer({
  session,
  scripts,
}: InProcessServerDeps): MagentaServer {
  const closers = new Set<() => void>();

  const projectors: {
    [K in TopicType]: (topic: TopicOf<K>) => Projection<StateMap[K]>;
  } = {
    global: () => globalState(session),
    session: (topic) =>
      topic.sessionId === session.id
        ? sessionState(session, scripts)
        : undefined,
    script: (topic) =>
      scripts ? scriptState(scripts, topic.invocationId) : undefined,
    thread: (topic) => {
      const record = session.getThread(topic.threadId);
      if (!record || record.state === "error") return undefined;
      if (record.state === "pending") return "waiting";
      return threadState(record.thread, record.compactor, session);
    },
  };

  function project<K extends TopicType>(
    topic: TopicOf<K>,
  ): Projection<StateMap[K]> {
    return projectors[topic.type](topic);
  }

  /** Registers the change sources for a topic, returning detach functions. */
  type Watcher<K extends TopicType> = (
    topic: TopicOf<K>,
    schedule: () => void,
  ) => Array<() => void>;

  function listen<E extends keyof SessionEvents>(
    event: E,
    handler: (...args: SessionEvents[E]) => void,
  ): () => void {
    session.on(event, handler);
    return () => session.off(event, handler);
  }

  function listenScripts(
    handler: (id?: ScriptInvocationId) => void,
  ): Array<() => void> {
    if (!scripts) return [];
    const events = [
      "catalogChanged",
      "invocationChanged",
      "invocationRemoved",
    ] as const;
    return events.map((event) => {
      scripts.on(event, handler);
      return () => scripts.off(event, handler);
    });
  }

  const sessionWide = (schedule: () => void) => [
    listen("changed", schedule),
    listen("removed", schedule),
    listen("settings-changed", schedule),
  ];

  const watchers: { [K in TopicType]: Watcher<K> } = {
    global: (_topic, schedule) => sessionWide(schedule),
    session: (_topic, schedule) => [
      ...sessionWide(schedule),
      ...listenScripts(schedule),
    ],
    script: (topic, schedule) => [
      ...sessionWide(schedule),
      ...listenScripts((id) => {
        if (id === topic.invocationId) schedule();
      }),
    ],
    thread: (topic, schedule) => {
      let detachCompactor: (() => void) | undefined;
      // The compactor only exists once the thread is ready.
      const attachCompactor = () => {
        if (detachCompactor) return;
        const record = session.getThread(topic.threadId);
        if (record?.state !== "initialized") return;
        const compactor = record.compactor;
        compactor?.on("transition", schedule);
        detachCompactor = () => compactor?.off("transition", schedule);
      };
      const onThread = (id: ThreadId) => {
        if (id !== topic.threadId) return;
        attachCompactor();
        schedule();
      };
      attachCompactor();
      return [
        listen("changed", onThread),
        listen("removed", onThread),
        () => detachCompactor?.(),
      ];
    },
  };

  function watch<K extends TopicType>(
    topic: TopicOf<K>,
    schedule: () => void,
  ): Array<() => void> {
    return watchers[topic.type](topic, schedule);
  }

  function subscribe<K extends TopicType>(
    topic: TopicOf<K>,
    listener: (state: StateMap[K] | undefined) => void,
  ): () => void {
    let closed = false;
    let scheduled = false;
    const close = () => {
      if (closed) return;
      closed = true;
      closers.delete(close);
      for (const d of detach) d();
    };
    const deliver = () => {
      if (closed) return;
      const state = project(topic);
      if (state === "waiting") return;
      listener(state);
      if (state === undefined) close();
    };
    function schedule() {
      if (scheduled || closed) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        deliver();
      });
    }
    const detach = watch(topic, schedule);
    closers.add(close);
    deliver();
    return close;
  }

  function getState<K extends TopicType>(
    topic: TopicOf<K>,
  ): StateMap[K] | undefined {
    const state = project(topic);
    return state === "waiting" ? undefined : state;
  }

  function readyThread(id: ThreadId): Thread {
    const record = session.getThread(id);
    if (record?.state !== "initialized") {
      throw new UnknownTarget(`Unknown thread ${id}`);
    }
    return record.thread;
  }

  function knownThread(id: ThreadId): void {
    if (!session.getThread(id)) throw new UnknownTarget(`Unknown thread ${id}`);
  }

  function requireSession(id: SessionId): void {
    if (id !== session.id) throw new UnknownTarget(`Unknown session ${id}`);
  }

  function requireScripts(): ScriptManager {
    if (!scripts) throw new UnknownTarget("Scripts are not available");
    return scripts;
  }

  function requireInvocation(id: ScriptInvocationId): ScriptManager {
    const manager = requireScripts();
    if (!manager.getInvocation(id)) {
      throw new UnknownTarget(`Unknown script invocation ${id}`);
    }
    return manager;
  }

  function created(
    id: ThreadId | Aborted,
  ): OperationSuccessMap["thread.create"] {
    return id === ABORTED
      ? { type: "aborted" }
      : { type: "created", threadId: id };
  }

  const ok = { type: "ok" } as const;

  function approveOrReject(
    op: OperationOf<"approval.approve" | "approval.reject">,
  ) {
    if (!session.getPendingApprovals(op.threadId).has(op.approvalId)) {
      throw new UnknownTarget(`Unknown approval ${op.approvalId}`);
    }
    if (op.type === "approval.approve") {
      session.approve(op.threadId, op.approvalId);
    } else {
      session.reject(op.threadId, op.approvalId);
    }
    return Promise.resolve(ok);
  }

  const handlers: {
    [K in OperationType]: (
      op: OperationOf<K>,
    ) => Promise<OperationSuccessMap[K]> | OperationSuccessMap[K];
  } = {
    "thread.create": async (op) => {
      requireSession(op.sessionId);
      return created(
        await (op.agent
          ? session.createAgentThread(op.agent)
          : session.createRootThread()),
      );
    },
    "thread.fork": async (op) =>
      created(await session.forkThread(op.threadId, op.nativeMessageIdx)),
    "thread.reflect": async (op) =>
      created(await session.reflectThread(op.threadId, op.anchor)),
    "thread.rewind": async (op) => {
      await readyThread(op.threadId).rewind(op.nativeMessageIdx);
      return ok;
    },
    "thread.delete": (op) => {
      knownThread(op.threadId);
      session.deleteThread(op.threadId);
      return ok;
    },
    "thread.submit": async (op) => {
      const thread = readyThread(op.threadId);
      session.markAttended(op.threadId);
      if (op.delivery === "async" || op.delivery === "next") {
        thread.enqueue(op.input, op.delivery);
        return { type: "queued" };
      }
      return {
        type: "submitted",
        submission: submissionResult(await thread.submit(op.input)),
      };
    },
    "thread.retry": async (op) => ({
      type: "submitted",
      submission: submissionResult(await readyThread(op.threadId).retry()),
    }),
    "thread.abort": async (op) => {
      knownThread(op.threadId);
      const { unsent } = await session.abortThread(op.threadId);
      return {
        type: "threadAborted",
        unsent: unsent.map((q) => renderPending(q.message)),
      };
    },
    "thread.setTitle": (op) => {
      readyThread(op.threadId).setTitle(op.title);
      return ok;
    },
    "thread.markAttended": (op) => {
      knownThread(op.threadId);
      session.markAttended(op.threadId);
      return ok;
    },
    "thread.recordActivity": (op) => {
      knownThread(op.threadId);
      session.recordActivity(op.threadId);
      return ok;
    },
    "thread.addContextFiles": async (op) => {
      await readyThread(op.threadId).contextFiles.addFiles(op.files);
      return ok;
    },
    "thread.removeContextFile": (op) => {
      readyThread(op.threadId).contextFiles.removeFileContext(op.file);
      return ok;
    },
    "tool.abort": (op) => {
      const state = readyThread(op.threadId).state;
      const entry =
        state.type === "running" &&
        state.activity.type === "running_tools" &&
        state.activity.tools.type === "running"
          ? state.activity.tools.activeTools.get(op.toolRequestId)
          : undefined;
      if (!entry) {
        throw new UnknownTarget(`No running tool ${op.toolRequestId}`);
      }
      entry.handle.abort();
      return ok;
    },
    "approval.approve": approveOrReject,
    "approval.reject": approveOrReject,
    "approval.approveAll": (op) => {
      knownThread(op.threadId);
      session.approveAll(op.threadId);
      return ok;
    },
    "approval.rejectAll": (op) => {
      knownThread(op.threadId);
      session.rejectAll(op.threadId);
      return ok;
    },
    "approval.approveAllInSubtree": (op) => {
      knownThread(op.threadId);
      session.approveAllPendingInSubtree(op.threadId);
      return ok;
    },
    "sandbox.toggleBypass": (op) => {
      knownThread(op.threadId);
      session.toggleSandboxBypass(op.threadId);
      return ok;
    },
    "session.setActiveProfile": (op) => {
      requireSession(op.sessionId);
      session.setActiveProfile(op.name);
      return ok;
    },
    "script.run": (op) => {
      requireSession(op.sessionId);
      const invocationId = requireScripts().startScript(
        op.name,
        op.parameters,
        { sandboxBypassed: false },
      );
      return { type: "started", invocationId };
    },
    "script.abort": (op) => {
      requireInvocation(op.invocationId).abortInvocation(op.invocationId);
      return ok;
    },
    "script.delete": (op) => {
      requireInvocation(op.invocationId).deleteInvocation(op.invocationId);
      return ok;
    },
    "script.toggleSandbox": (op) => {
      requireInvocation(op.invocationId).toggleInvocationSandbox(
        op.invocationId,
      );
      return ok;
    },
    "script.discover": async (op) => {
      requireSession(op.sessionId);
      await requireScripts().discover();
      return ok;
    },
  };

  function dispatch<O extends Operation>(
    op: O,
  ): Promise<OperationSuccessMap[O["type"]]> {
    // Correlated lookup: TS can't relate `handlers[op.type]` to `op`.
    const handler = handlers[op.type] as unknown as (
      op: O,
    ) =>
      | Promise<OperationSuccessMap[O["type"]]>
      | OperationSuccessMap[O["type"]];
    return Promise.resolve(handler(op));
  }

  return {
    subscribe,
    getState,
    async execute<O extends Operation>(op: O): Promise<OperationResultFor<O>> {
      try {
        return await dispatch(op);
      } catch (error) {
        return {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    attachClient: (client) => session.attachClient(client),
    detachClient: () => session.detachClient(),
    // The composition root still owns the session and script manager in this
    // stage; disposing the server only ends subscriptions.
    async dispose() {
      for (const close of [...closers]) close();
    },
  };
}
