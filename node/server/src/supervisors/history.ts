import type { NativeMessageIdx } from "../providers/provider-types.ts";

/**
 * Where a supervisor history entry sits in the native conversation. Entries
 * recorded outside a request predate every message this generation can name,
 * so they are their own case rather than an out-of-domain index.
 */
export type HistoryIdx = NativeMessageIdx | { type: "pre-history" };

export const PRE_HISTORY = { type: "pre-history" } as const;

/** True when the entry is at or before `idx`; pre-history always is. */
export function historyIdxAtOrBefore(
  entry: HistoryIdx,
  idx: NativeMessageIdx,
): boolean {
  return typeof entry === "number" ? entry <= idx : true;
}

/** True when `entry` is strictly older than `previous`, which is what a
 * monotonic history forbids. */
export function historyIdxPrecedes(
  entry: HistoryIdx,
  previous: HistoryIdx,
): boolean {
  return historyIdxOrder(entry) < historyIdxOrder(previous);
}

export function formatHistoryIdx(entry: HistoryIdx): string {
  return typeof entry === "number" ? String(entry) : "pre-history";
}

function historyIdxOrder(entry: HistoryIdx): number {
  return typeof entry === "number" ? entry : Number.NEGATIVE_INFINITY;
}
