import type { DockerSpawnConfig } from "./capabilities/thread-manager.ts";
import type { ThreadId, ThreadType } from "./chat-types.ts";
import { ThreadCompactor } from "./compaction/compactor.ts";
import { TokenBudget } from "./compaction/token-budget.ts";
import { DockerSupervisor } from "./docker-supervisor.ts";
import type {
  AgentInput,
  NativeMessageIdx,
} from "./providers/provider-types.ts";
import {
  Thread,
  type ThreadArchiveOptions,
  type ThreadCallbacks,
  type ThreadContext,
  type ThreadContextBase,
} from "./thread.ts";
import { archiveThread, type ThreadLogger } from "./thread-logger.ts";
import {
  MaxTokensSupervisor,
  SubagentSupervisor,
  type TurnSupervisor,
} from "./thread-supervisor.ts";
import { generateTitle } from "./tools/thread-title.ts";

/** Construction knobs for a conversation thread. A compaction thread cannot
 * carry them: it is itself a compaction and never auto-compacts. Option
 * fallbacks are resolved by the host, so assembly never reads editor
 * options. */
export type ChatThreadPolicy = {
  /** Progress reporting is only meaningful for a supervised docker thread, so
   * it lives inside the docker config rather than beside it. */
  docker?: DockerSpawnConfig & { onProgress?: (message: string) => void };
  autoCompactThreshold?: number;
  /** The handoff prompt an automatic compaction continues with. */
  autoCompactPrompt: string;
};

/** The dependencies a host prepares. Conversation kind, supervisors and
 * the compactor are assembly's job, not the host's. */
export type PreparedThreadContext = Omit<
  ThreadContextBase,
  "turnSupervisors" | "toolLoopSupervisors" | "compactor"
>;

export type ChatThreadType = Exclude<ThreadType, "compact">;

/** A fork inherits both its conversation kind and its compaction knobs from
 * its source, so it carries no policy of its own. */
export type ThreadInitialization =
  | {
      type: "fresh";
      threadType: "compact";
      archiveOptions?: ThreadArchiveOptions;
    }
  | {
      type: "fresh";
      threadType: ChatThreadType;
      policy: ChatThreadPolicy;
      archiveOptions?: ThreadArchiveOptions;
    }
  | {
      type: "fork";
      sourceThread: Thread;
      nativeMessageIdx: NativeMessageIdx;
    };

/** Only a conversation thread has a compactor. The compact variant keeps the
 * key present as `undefined` so callers can destructure either variant, while
 * the invalid combinations stay unrepresentable. */
export type AssembledThread =
  | {
      threadType: "compact";
      thread: Thread;
      archive: ThreadLogger;
      compactor?: undefined;
    }
  | {
      threadType: ChatThreadType;
      thread: Thread;
      archive: ThreadLogger;
      compactor: ThreadCompactor;
    };

/** The fresh/fork distinction resolved down to what construction needs: which
 * conversation kind, and where its auto-compaction settings come from. */
type Conversation =
  | { threadType: "compact" }
  | {
      threadType: ChatThreadType;
      autoCompact:
        | { type: "policy"; policy: ChatThreadPolicy }
        | { type: "inherit"; source: TokenBudget };
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
}): AssembledThread {
  const { id, initialization, context, callbacks } = args;
  const conversation = resolveConversation(initialization);
  const docker =
    initialization.type === "fresh" && initialization.threadType !== "compact"
      ? initialization.policy.docker
      : undefined;

  const titles = new TitleSupervisor(context);

  const tokenBudget = buildTokenBudget(conversation);
  const base = {
    ...context,
    turnSupervisors: [...buildTurnSupervisors(conversation, docker), titles],
    ...(tokenBudget ? { tokenBudget } : {}),
  };

  const build = (
    dependencies: ThreadContext,
  ): { thread: Thread; archive: ThreadLogger } =>
    archiveThread({
      logger: context.logger,
      callbacks,
      ...(context.cwd !== undefined ? { cwd: context.cwd } : {}),
      build: (threadCallbacks) => {
        const thread =
          initialization.type === "fork"
            ? Thread.clone({
                sourceThread: initialization.sourceThread,
                nativeMessageIdx: initialization.nativeMessageIdx,
                newId: id,
                context: dependencies,
                callbacks: threadCallbacks,
              })
            : new Thread(
                id,
                dependencies,
                threadCallbacks,
                initialization.archiveOptions ?? {},
              );
        // Construction invokes no callbacks and resolves no submissions, so
        // the scheduler is attached before it can be consulted.
        titles.attach(thread);
        return thread;
      },
    });

  if (conversation.threadType === "compact") {
    return {
      threadType: "compact",
      ...build({ ...base, threadType: "compact" }),
    };
  }

  const compactor = new ThreadCompactor({
    parentThreadId: id,
    threadManager: context.threadManager,
  });
  return {
    threadType: conversation.threadType,
    compactor,
    ...build({
      ...base,
      threadType: conversation.threadType,
      compactor,
    }),
  };
}

function resolveConversation(
  initialization: ThreadInitialization,
): Conversation {
  if (initialization.type === "fresh") {
    return initialization.threadType === "compact"
      ? { threadType: "compact" }
      : {
          threadType: initialization.threadType,
          autoCompact: { type: "policy", policy: initialization.policy },
        };
  }
  const source = initialization.sourceThread;
  if (source.threadType === "compact") return { threadType: "compact" };
  const sourceBudget = source.tokenBudget;
  if (!sourceBudget) {
    throw new Error(
      `Cannot fork thread ${source.id}: no token budget to inherit`,
    );
  }
  return {
    threadType: source.threadType,
    autoCompact: { type: "inherit", source: sourceBudget },
  };
}

function buildTurnSupervisors(
  conversation: Conversation,
  docker: ChatThreadPolicy["docker"],
): TurnSupervisor[] {
  const supervisors: TurnSupervisor[] = [MaxTokensSupervisor.create()];
  if (docker?.supervised) {
    supervisors.push(
      DockerSupervisor.create({
        containerName: docker.containerName,
        workspacePath: docker.workspacePath,
        hostDir: docker.hostDir,
        ...(docker.onProgress ? { onProgress: docker.onProgress } : {}),
      }),
    );
  } else if (
    conversation.threadType === "subagent" ||
    conversation.threadType === "docker_root" ||
    conversation.threadType === "compact"
  ) {
    supervisors.push(SubagentSupervisor.create());
  }
  return supervisors;
}

function buildTokenBudget(conversation: Conversation): TokenBudget | undefined {
  if (conversation.threadType === "compact") return undefined;
  const { autoCompact } = conversation;
  return autoCompact.type === "inherit"
    ? TokenBudget.clone({ source: autoCompact.source })
    : TokenBudget.create({
        ...(autoCompact.policy.autoCompactThreshold !== undefined
          ? { threshold: autoCompact.policy.autoCompactThreshold }
          : {}),
        handoff: autoCompact.policy.autoCompactPrompt,
      });
}

/** Requests a title once, from the first submission that carries text. It is
 * a turn supervisor so it survives core replacement and needs no owner-facing
 * callback; a late response cannot overwrite an explicit label or a destroyed
 * thread. */
export class TitleSupervisor implements TurnSupervisor {
  /** The attachment and request facts are one state, so "requested but no
   * thread" is not representable. Construction invokes no hooks, so the
   * thread is always attached before the first submission is reported. */
  private state:
    | { type: "unattached" }
    | { type: "pending"; thread: Thread }
    | { type: "requested" } = { type: "unattached" };
  constructor(private readonly context: PreparedThreadContext) {}
  attach(thread: Thread): void {
    this.state = { type: "pending", thread };
  }
  onSubmission(messages: readonly AgentInput[]): void {
    if (this.state.type !== "pending") return;
    const thread = this.state.thread;
    if (
      thread.isDestroyed ||
      thread.title !== undefined ||
      thread.threadType === "compact" ||
      !messages.length
    )
      return;
    const text = messages
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n");
    this.state = { type: "requested" };
    generateTitle(
      this.context.provider,
      this.context.profile.fastModel,
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
        this.context.logger.error(
          `Error getting thread title: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}
