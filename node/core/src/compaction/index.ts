import type {
  CompactionRecord,
  CompactionStep,
} from "../compaction-controller.ts";
import { CompactionManager } from "../compaction-manager.ts";
import { Emitter } from "../emitter.ts";
import type { ProviderMessage } from "../providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "../providers/provider-types.ts";
import type { Thread } from "../thread.ts";
import type { SendResult, ThreadSendResult } from "../thread-api.ts";

/** The one suspension reason core's compaction loop understands. Everything
 * else that suspends is somebody else's business. */
export type CompactSuspendReason = {
  kind: "compact";
  nextPrompt: string | undefined;
};

export function asCompactReason(
  reason: unknown,
): CompactSuspendReason | undefined {
  if (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { kind?: unknown }).kind === "compact"
  ) {
    return reason as CompactSuspendReason;
  }
  return undefined;
}

export type CompactionOutcome =
  | { type: "complete"; summary: string; steps: CompactionStep[] }
  | { type: "error"; steps: CompactionStep[] };

/** Summarize a transcript. Owned by whoever owns the thread, so a thread that
 * has no compactor (a compact thread) simply stops when it suspends. */
export interface Compactor {
  run(
    messages: ReadonlyArray<ProviderMessage>,
    nextPrompt: string | undefined,
  ): Promise<CompactionOutcome>;
}

/** What a run is doing right now, for the view. */
export type CompactionProgress = {
  chunkIndex: number;
  totalChunks: number;
};

export type CompactorEvents = {
  /** undefined once the run is over */
  progress: [CompactionProgress | undefined];
};

/** The `Compactor` in use today: the hand-rolled `CompactionManager` state
 * machine, wrapped in a promise. Stage 3 replaces its innards with real child
 * threads; nothing outside this file has to know which it is. */
export class ManagedCompactor extends Emitter<CompactorEvents> {
  /** Finished runs, most recent last. The view renders these. */
  readonly history: CompactionRecord[] = [];
  progress: CompactionProgress | undefined;
  /** The in-flight manager, exposed so the view can reach its live agent. */
  manager: CompactionManager | undefined;

  constructor(private thread: Thread) {
    super();
  }

  run(
    messages: ReadonlyArray<ProviderMessage>,
    nextPrompt: string | undefined,
  ): Promise<CompactionOutcome> {
    const context = this.thread.context;
    const manager = new CompactionManager({
      logger: context.logger,
      profile: context.profile,
      mcpToolManager: context.mcpToolManager,
      threadId: this.thread.id,
      cwd: context.cwd,
      homeDir: context.homeDir,
      lspClient: context.lspClient,
      availableCapabilities: context.availableCapabilities,
      contextTracker: context.contextTracker,
      onToolApplied: (absFilePath, tool, fileTypeInfo) =>
        this.thread.hooks.onToolApplied?.(absFilePath, tool, fileTypeInfo),
      shell: context.shell,
      threadManager: context.threadManager,
      maxConcurrentSubagents: context.maxConcurrentSubagents,
      maxConcurrentFastSubagents: context.maxConcurrentFastSubagents,
      getProvider: context.getProvider,
      requestRender: () => this.thread.callbacks.onUpdate(),
    });
    this.manager = manager;

    return new Promise<CompactionOutcome>((resolve) => {
      manager.on("transition", (_prev, next) => {
        switch (next.type) {
          case "processing-chunk":
          case "waiting-for-tools":
            this.setProgress({
              chunkIndex: next.chunkIndex,
              totalChunks: next.totalChunks,
            });
            return;
          case "complete":
            this.finish(
              next.result.type === "complete"
                ? {
                    type: "complete",
                    summary: next.result.summary,
                    steps: next.result.steps,
                  }
                : { type: "error", steps: next.result.steps },
              resolve,
            );
            return;
          case "error":
            this.finish({ type: "error", steps: next.steps }, resolve);
            return;
          default:
            return;
        }
      });
      manager.start(messages, nextPrompt);
    });
  }

  private setProgress(progress: CompactionProgress | undefined): void {
    this.progress = progress;
    this.emit("progress", progress);
  }

  private finish(
    outcome: CompactionOutcome,
    resolve: (outcome: CompactionOutcome) => void,
  ): void {
    this.manager = undefined;
    this.history.push({
      steps: outcome.steps,
      finalSummary: outcome.type === "complete" ? outcome.summary : undefined,
    });
    this.setProgress(undefined);
    resolve(outcome);
  }
}

export function summaryText(summary: string): string {
  return `<conversation-summary>\n${summary}\n</conversation-summary>`;
}

/** Follow one submission across every compaction it triggers. This is the
 * only place a `suspended` result is interpreted, and the only place the
 * caller's promise is held pending across the agent swap — which is why every
 * submission path must go through it. */
export async function runSubmission(args: {
  thread: Thread;
  /** absent for threads that must never compact (compact threads themselves) */
  compactor: Compactor | undefined;
  start: () => Promise<ThreadSendResult>;
}): Promise<ThreadSendResult> {
  const { thread, compactor } = args;
  let result = await args.start();

  while (result.type === "suspended") {
    const reason = asCompactReason(result.reason);
    if (!reason || !compactor) {
      // A suspension nobody claims is just a stop.
      return { type: "completed" } satisfies SendResult;
    }

    const outcome = await compactor.run(
      thread.getProviderMessages(),
      reason.nextPrompt,
    );
    if (outcome.type === "error") {
      return {
        type: "failed",
        error: new Error("Compaction failed"),
        resubmit: undefined,
      } satisfies SendResult;
    }

    await thread.reset(
      [
        {
          type: "text",
          text: summaryText(outcome.summary),
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ],
      { summary: outcome.summary, chunkCount: outcome.steps.length },
    );

    result = await thread.send([
      {
        type: "user",
        text: reason.nextPrompt ?? "Please continue from where you left off.",
      },
    ]);
  }

  return result;
}
