/** Constants shared by every provider's `NativeInferenceManager`. They describe
 * turn-loop facts (what an aborted turn leaves behind, how long a request may
 * keep retrying), not anything provider-specific, so neither manager has to
 * reach into the other's file for them. */

/** Appended to the conversation when a turn is cut short by the user, so the
 * model sees why the transcript stops where it does. */
export const ABORT_MARKER_TEXT = "[The user aborted the previous request.]";

/** Result recorded for any tool_use the executor never answered because the
 * turn was aborted first. */
export const ABORT_TOOL_RESULT_TEXT =
  "Request was aborted by the user before tool execution completed.";

export const RETRY_DELAYS = [1000, 5000, 10000, 30000] as const;

export const MAX_RETRY_DURATION = 300_000;

export function getRetryDelay(attempt: number): number {
  return attempt < RETRY_DELAYS.length
    ? RETRY_DELAYS[attempt]
    : RETRY_DELAYS[RETRY_DELAYS.length - 1];
}
