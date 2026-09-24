import type {
  AgentInput,
  ProviderMessage,
} from "../providers/provider-types.ts";

export type CompactionOutcome =
  | {
      type: "complete";
      /** Absent when there was nothing to summarize. */
      summary: { text: string; chunkCount: number } | undefined;
      /** Sent verbatim on the fresh core: the handoff followed by any
       * unanswered user turn carried out of the log. Empty means "continue". */
      next: AgentInput[];
    }
  | { type: "error"; message: string }
  /** the run's child threads were deleted, or the parent went away */
  | { type: "aborted" };

/** Thread hands over the whole log and the handoff input; how the log is
 * summarized and what is carried past it belong to the compactor. */
/** A supplied capability consumed by Thread's submission coordinator.
 * A thread without a compactor treats an unclaimed suspension as a stop. */
export interface Compactor {
  run(
    messages: ReadonlyArray<ProviderMessage>,
    next: ReadonlyArray<AgentInput>,
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
