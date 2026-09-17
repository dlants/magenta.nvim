import type { ProviderMessage } from "../providers/provider-types.ts";

/** A handoff consumed by Thread's submission coordinator when it has a compactor. */
export type CompactSuspendReason = {
  kind: "compact";
  nextPrompt: string | undefined;
};

export type CompactionOutcome =
  | { type: "complete"; summary: string; chunkCount: number }
  | { type: "error"; message: string }
  /** the run's child threads were deleted, or the parent went away */
  | { type: "aborted" };

/** A supplied capability consumed by Thread's submission coordinator.
 * A thread without a compactor treats an unclaimed suspension as a stop. */
export interface Compactor {
  run(
    messages: ReadonlyArray<ProviderMessage>,
    nextPrompt: string | undefined,
    signal: AbortSignal,
  ): Promise<CompactionOutcome>;
}

export {
  type CompactionRunId,
  type CompactionRunState,
  compactionRunChunkIndex,
  compactionRunThreadIds,
  ThreadCompactor,
  type ThreadCompactorDeps,
  type ThreadCompactorEvents,
} from "./compactor.ts";
export function summaryText(summary: string): string {
  return `<conversation-summary>\n${summary}\n</conversation-summary>`;
}
