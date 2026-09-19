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

/** The dependencies a host prepares. Conversation kind, chat supervisors and
 * the compactor are assembly's job, not the host's. */
export type PreparedThreadContext = Omit<
  ThreadCloneContext,
  "chatSupervisors" | "compactor"
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
  | { threadType: "compact"; thread: Thread; compactor?: undefined }
  | { threadType: ChatThreadType; thread: Thread; compactor: ThreadCompactor };

/** The fresh/fork distinction resolved down to what construction needs: which
 * conversation kind, and where its auto-compaction settings come from. */
type Conversation =
  | { threadType: "compact" }
  | {
      threadType: ChatThreadType;
      autoCompact:
        | { type: "policy"; policy: ChatThreadPolicy }
        | { type: "inherit"; source: AutoCompactSupervisor };
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

  const base = {
    ...context,
    chatSupervisors: [...buildChatSupervisors(conversation, docker), titles],
  };

  const build = (dependencies: ThreadContext): Thread => {
    const thread =
      initialization.type === "fork"
        ? Thread.clone({
            sourceThread: initialization.sourceThread,
            nativeMessageIdx: initialization.nativeMessageIdx,
            newId: id,
            context: threadCloneContext(dependencies),
            callbacks,
          })
        : new Thread(
            id,
            dependencies,
            callbacks,
            initialization.archiveOptions ?? {},
          );
    // Construction invokes no callbacks and resolves no submissions, so the
    // scheduler is attached before it can be consulted.
    titles.attach(thread);
    return thread;
  };

  if (conversation.threadType === "compact") {
    return {
      threadType: "compact",
      thread: build({ ...base, threadType: "compact" }),
    };
  }

  const compactor = new ThreadCompactor({
    parentThreadId: id,
    threadManager: context.threadManager,
  });
  return {
    threadType: conversation.threadType,
    compactor,
    thread: build({
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
  const sourceAutoCompact = AutoCompactSupervisor.find(source.chatSupervisors);
  if (!sourceAutoCompact) {
    throw new Error(
      `Cannot fork thread ${source.id}: no auto-compaction supervisor to inherit`,
    );
  }
  return {
    threadType: source.threadType,
    autoCompact: { type: "inherit", source: sourceAutoCompact },
  };
}

function buildChatSupervisors(
  conversation: Conversation,
  docker: ChatThreadPolicy["docker"],
): ThreadSupervisor[] {
  const supervisors: ThreadSupervisor[] = [MaxTokensSupervisor.create()];
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
  if (conversation.threadType !== "compact") {
    const { autoCompact } = conversation;
    supervisors.push(
      autoCompact.type === "inherit"
        ? AutoCompactSupervisor.clone({ source: autoCompact.source })
        : AutoCompactSupervisor.create({
            ...(autoCompact.policy.autoCompactThreshold !== undefined
              ? { threshold: autoCompact.policy.autoCompactThreshold }
              : {}),
            nextPrompt: autoCompact.policy.autoCompactPrompt,
          }),
    );
  }
  return supervisors;
}

/** Requests a title once, from the first submission that carries text. It is
 * a chat supervisor so it survives core replacement and needs no owner-facing
 * callback; a late response cannot overwrite an explicit label or a destroyed
 * thread. */
export class TitleSupervisor implements ThreadSupervisor {
  private requested = false;
  private thread: Thread | undefined;

  constructor(private readonly context: PreparedThreadContext) {}

  /** Construction invokes no hooks, so the thread is always attached before
   * the first submission can be reported. */
  attach(thread: Thread): void {
    this.thread = thread;
  }

  onSubmission(messages: readonly AgentInput[]): void {
    const thread = this.thread;
    if (
      !thread ||
      this.requested ||
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
    this.requested = true;
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
