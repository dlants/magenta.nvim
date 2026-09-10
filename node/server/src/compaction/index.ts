import type { ProviderMessage } from "../providers/provider-types.ts";
import type { Thread } from "../thread.ts";
import type { SendResult, ThreadSendResult } from "../thread-api.ts";

/** The one suspension reason core's compaction loop understands. Everything
 * else that suspends is somebody else's business. */
export type CompactSuspendReason = {
  kind: "compact";
  nextPrompt: string | undefined;
};

export type CompactionOutcome =
  | { type: "complete"; summary: string; chunkCount: number }
  | { type: "error"; message: string }
  /** the run's child threads were deleted, or the parent went away */
  | { type: "aborted" };

/** Summarize a transcript. Owned by whoever owns the thread, so a thread that
 * has no compactor (a compact thread) simply stops when it suspends. */
export interface Compactor {
  run(
    messages: ReadonlyArray<ProviderMessage>,
    nextPrompt: string | undefined,
  ): Promise<CompactionOutcome>;
}

export {
  type CompactionRunId,
  type CompactionRunState,
  compactionRunChunkIndex,
  compactionRunThreadIds,
  ThreadCompactor,
  type ThreadCompactorEvents,
} from "./compactor.ts";
export function summaryText(summary: string): string {
  return `<conversation-summary>\n${summary}\n</conversation-summary>`;
}

export async function runSubmission(args: {
  thread: Thread;
  compactor: Compactor | undefined;
  start: () => Promise<ThreadSendResult>;
}): Promise<ThreadSendResult> {
  const { thread, compactor } = args;
  let core = thread.core;
  const started = args.start();
  let signal = thread.interruptionSignal;
  const isCurrent = () =>
    !signal.aborted && thread.core === core && core.isActive;
  let result = await started;

  while (result.type === "suspended") {
    if (!isCurrent()) return { type: "aborted" };
    const reason = result.reason;
    if (reason.kind !== "compact" || !compactor) {
      // A suspension nobody claims is just a stop.
      return { type: "empty" } satisfies SendResult;
    }

    const outcome = await compactor.run(
      thread.getProviderMessages(),
      reason.nextPrompt,
    );
    if (!isCurrent() || outcome.type === "aborted") {
      return { type: "aborted" } satisfies SendResult;
    }
    if (outcome.type === "error") {
      return {
        type: "failed",
        error: new Error(`Compaction failed: ${outcome.message}`),
      } satisfies SendResult;
    }

    try {
      const reset = thread.reset({
        seed: [{ type: "user", text: summaryText(outcome.summary) }],
        archive: {
          type: "compaction",
          summary: outcome.summary,
          chunkCount: outcome.chunkCount,
        },
      });
      signal = thread.interruptionSignal;
      core = await reset;
    } catch (error) {
      if (!isCurrent()) return { type: "aborted" };
      throw error;
    }
    if (!isCurrent()) return { type: "aborted" };

    const sent = thread.send([
      {
        type: "user",
        text:
          reason.nextPrompt?.trim() ||
          "Please continue from where you left off.",
      },
    ]);
    signal = thread.interruptionSignal;
    result = await sent;
  }

  return result;
}
