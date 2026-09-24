/** Constants shared by every provider's `NativeInferenceManager`. They describe
 * turn-loop facts (what an aborted turn leaves behind, how long a request may
 * keep retrying), not anything provider-specific, so neither manager has to
 * reach into the other's file for them. */

import type { RequestedTool, ToolResults } from "./provider-types.ts";

/** Appended to the conversation when a turn is cut short by the user, so the
 * model sees why the transcript stops where it does. */
export const ABORT_MARKER_TEXT = "[The user aborted the previous request.]";

/** Result recorded for any tool_use the executor never answered because the
 * turn was aborted first. */
export const ABORT_TOOL_RESULT_TEXT =
  "Request was aborted by the user before tool execution completed.";

/** Result the agent records for a tool_use its executor never answered for
 * any other reason. */
export const UNANSWERED_TOOL_RESULT_TEXT =
  "Tool execution did not report a result.";

/** The log is only well-formed if every tool_use is answered exactly once.
 * Filling a gap is a decision about the turn, so it belongs to the agent: a
 * manager handed an incomplete map has been lied to and says so. */
export function assertCompleteToolResults(
  requested: ReadonlyArray<RequestedTool>,
  results: ToolResults,
): void {
  const missing = requested.filter(({ id }) => !results.has(id));
  if (missing.length) {
    throw new Error(
      `appendToolResults: no result for tool_use ${missing.map(({ id }) => id).join(", ")}`,
    );
  }
  if (results.size !== requested.length) {
    throw new Error(
      `appendToolResults: ${results.size} results for ${requested.length} requested tools`,
    );
  }
}

export const RETRY_DELAYS = [1000, 5000, 10000, 30000] as const;

/** After asking the SDK to abort, stop waiting even if its stream never settles. */
export const ABORT_GRACE_PERIOD_MS = 2_000;

export const ABORT_TIMED_OUT = Symbol("abort-timed-out");

export async function wrapStreamAbortSignalWithTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORT_TIMED_OUT> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const abortTimeout = new Promise<typeof ABORT_TIMED_OUT>((resolve) => {
    onAbort = () => {
      timeout = setTimeout(
        () => resolve(ABORT_TIMED_OUT),
        ABORT_GRACE_PERIOD_MS,
      );
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, abortTimeout]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export const MAX_RETRY_DURATION = 300_000;

export function getRetryDelay(attempt: number): number {
  return attempt < RETRY_DELAYS.length
    ? RETRY_DELAYS[attempt]
    : RETRY_DELAYS[RETRY_DELAYS.length - 1];
}

/** Ties an already-started request to `signal`. `started` must have run
 * synchronously far enough for `abort` to find the request in flight. */
export function withAbort<T>(
  started: Promise<T>,
  signal: AbortSignal,
  abort: () => void,
): Promise<T> {
  if (signal.aborted) abort();
  signal.addEventListener("abort", abort, { once: true });
  return started.finally(() => signal.removeEventListener("abort", abort));
}
