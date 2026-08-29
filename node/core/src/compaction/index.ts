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
  type CompactionRunState,
  ThreadCompactor,
  type ThreadCompactorEvents,
} from "./compactor.ts";
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
    const reason = result.reason;
    if (reason.kind !== "compact" || !compactor) {
      // A suspension nobody claims is just a stop.
      return { type: "completed" } satisfies SendResult;
    }

    const outcome = await compactor.run(
      thread.getProviderMessages(),
      reason.nextPrompt,
    );
    if (outcome.type === "aborted") {
      return { type: "aborted" } satisfies SendResult;
    }
    if (outcome.type === "error") {
      return {
        type: "failed",
        error: new Error(`Compaction failed: ${outcome.message}`),
        resubmit: undefined,
      } satisfies SendResult;
    }

    await thread.reset({
      seed: [
        {
          type: "text",
          text: summaryText(outcome.summary),
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ],
      archive: {
        type: "compaction",
        summary: outcome.summary,
        chunkCount: outcome.chunkCount,
      },
    });

    result = await thread.send([
      {
        type: "user",
        text: reason.nextPrompt ?? "Please continue from where you left off.",
      },
    ]);
  }

  return result;
}
