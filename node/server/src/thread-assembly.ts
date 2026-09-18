import type { DockerSpawnConfig } from "./capabilities/thread-manager.ts";
import type { ThreadId, ThreadType } from "./chat-types.ts";
import { ThreadCompactor } from "./compaction/compactor.ts";
import { DockerSupervisor } from "./docker-supervisor.ts";
import type {
  AgentInput,
  NativeMessageIdx,
} from "./providers/provider-types.ts";
import {
  Thread,
  type ThreadArchiveOptions,
  type ThreadCallbacks,
  type ThreadCloneContext,
  type ThreadContext,
  threadCloneContext,
} from "./thread.ts";
import {
  AutoCompactSupervisor,
  MaxTokensSupervisor,
  SubagentSupervisor,
  type ThreadSupervisor,
} from "./thread-supervisor.ts";
import { generateTitle } from "./tools/thread-title.ts";

/** Construction knobs that are decided per thread rather than per environment.
 * Defaults (option fallbacks) are resolved by the host before assembly, so
 * assembly never reads editor options. */
export type ThreadPolicy = {
  docker?: DockerSpawnConfig;
  onDockerProgress?: (message: string) => void;
  autoCompactThreshold?: number;
  /** Required for non-compact threads: the handoff prompt an automatic
   * compaction continues with. Hosts resolve their own default. */
  autoCompactPrompt?: string;
};

/** The dependencies a host prepares. Conversation kind, chat supervisors and
 * the compactor are assembly's job, not the host's. */
export type PreparedThreadContext = Omit<
  ThreadCloneContext,
  "chatSupervisors" | "compactor"
>;

export type ThreadInitialization =
  | {
      type: "fresh";
      threadType: ThreadType;
      archiveOptions?: ThreadArchiveOptions;
    }
  | {
      type: "fork";
      sourceThread: Thread;
      nativeMessageIdx: NativeMessageIdx;
    };

export type AssembledThread = {
  thread: Thread;
  compactor: ThreadCompactor | undefined;
};

/** Build a ready Thread (plus its compactor) from prepared dependencies.
 * Callers get handles, not a construction recipe: supervisor ordering,
 * compactor wiring and automatic title generation all live here so a view
 * wrapper is never required for any of them. */
export function assembleThread(args: {
  id: ThreadId;
  initialization: ThreadInitialization;
  context: PreparedThreadContext;
  callbacks: ThreadCallbacks;
  policy?: ThreadPolicy;
}): AssembledThread {
  const { id, initialization, context, callbacks } = args;
  const policy = args.policy ?? {};
  const threadType =
    initialization.type === "fresh"
      ? initialization.threadType
      : initialization.sourceThread.threadType;

  const compactor =
    threadType === "compact"
      ? undefined
      : new ThreadCompactor({
          parentThreadId: id,
          threadManager: context.threadManager,
        });

  const chatSupervisors = buildChatSupervisors(
    threadType,
    initialization,
    policy,
  );

  const base = {
    ...context,
    ...(compactor ? { compactor } : {}),
    chatSupervisors,
  };
  const dependencies: ThreadContext =
    threadType === "compact"
      ? { ...base, threadType }
      : { ...base, threadType };

  // Neither construction path invokes callbacks or resolves submissions, so
  // the title scheduler can close over the thread it is about to observe.
  let thread!: Thread;
  const titleScheduler = createTitleScheduler(() => thread, context);
  const wrappedCallbacks: ThreadCallbacks = {
    ...callbacks,
    onSubmission: (messages) => {
      titleScheduler(messages);
      callbacks.onSubmission?.(messages);
    },
  };

  thread =
    initialization.type === "fork"
      ? Thread.clone({
          sourceThread: initialization.sourceThread,
          nativeMessageIdx: initialization.nativeMessageIdx,
          newId: id,
          context: threadCloneContext(dependencies),
          callbacks: wrappedCallbacks,
        })
      : new Thread(
          id,
          dependencies,
          wrappedCallbacks,
          initialization.archiveOptions ?? {},
        );

  return { thread, compactor };
}

function buildChatSupervisors(
  threadType: ThreadType,
  initialization: ThreadInitialization,
  policy: ThreadPolicy,
): ThreadSupervisor[] {
  const supervisors: ThreadSupervisor[] = [MaxTokensSupervisor.create()];
  if (policy.docker?.supervised) {
    supervisors.push(
      DockerSupervisor.create({
        containerName: policy.docker.containerName,
        workspacePath: policy.docker.workspacePath,
        hostDir: policy.docker.hostDir,
        ...(policy.onDockerProgress
          ? { onProgress: policy.onDockerProgress }
          : {}),
      }),
    );
  } else if (
    threadType === "subagent" ||
    threadType === "docker_root" ||
    threadType === "compact"
  ) {
    supervisors.push(SubagentSupervisor.create());
  }
  if (threadType !== "compact") {
    const sourceAutoCompact =
      initialization.type === "fork"
        ? initialization.sourceThread.chatSupervisors?.find(
            (supervisor): supervisor is AutoCompactSupervisor =>
              supervisor instanceof AutoCompactSupervisor,
          )
        : undefined;
    supervisors.push(
      sourceAutoCompact
        ? AutoCompactSupervisor.clone({ source: sourceAutoCompact })
        : AutoCompactSupervisor.create({
            ...(policy.autoCompactThreshold !== undefined
              ? { threshold: policy.autoCompactThreshold }
              : {}),
            nextPrompt: policy.autoCompactPrompt ?? "",
          }),
    );
  }
  return supervisors;
}

/** Request a title once, from the first submission that carries text. A late
 * response cannot overwrite an explicit label or a destroyed thread. */
function createTitleScheduler(
  getThread: () => Thread,
  context: PreparedThreadContext,
): (messages: readonly AgentInput[]) => void {
  let requested = false;
  return (messages) => {
    const thread = getThread();
    if (
      requested ||
      thread.isDestroyed ||
      thread.title !== undefined ||
      thread.threadType === "compact" ||
      !messages.length
    )
      return;
    requested = true;
    const text = messages
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n");
    generateTitle(
      context.provider,
      context.profile.fastModel,
      thread.systemPrompt,
      text,
    )
      .then((title) => {
        if (
          title !== undefined &&
          !thread.isDestroyed &&
          thread.title === undefined
        )
          thread.setTitle(title);
      })
      .catch((error: unknown) => {
        context.logger.error(
          `Error getting thread title: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };
}
