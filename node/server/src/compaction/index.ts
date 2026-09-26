import type {
  AgentInput,
  ProviderMessage,
} from "../providers/provider-types.ts";
import type { Task } from "../utils/async.ts";

export type CompactionOutcome =
  | {
      type: "complete";
      summary: { text: string; chunkCount: number };
      /** Sent verbatim on the fresh core: the handoff followed by any
       * unanswered user turn carried out of the log. Empty means "continue". */
      next: AgentInput[];
    }
  /** Nothing to summarize: the log held only the unanswered user turn. */
  | { type: "carried"; next: AgentInput[] }
  | { type: "error"; message: string }
  /** the run's child threads were deleted, or the parent went away */
  | { type: "aborted" };

/** A supplied capability consumed by Thread's submission coordinator.
 * Thread hands over the whole log and the handoff input; how the log is
 * summarized and what is carried past it belong to the compactor.
 * A thread without a compactor treats an unclaimed suspension as a stop. */
export interface Compactor {
  run(
    messages: ReadonlyArray<ProviderMessage>,
    next: ReadonlyArray<AgentInput>,
  ): Task<CompactionOutcome>;
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
