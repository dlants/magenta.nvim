import type { NativeMessageIdx } from "../providers/provider-types.ts";

/**
 * Older than any message this generation can name: a history entry stamped
 * with it survives every truncation, because `entry.idx <= idx` always holds.
 */
export const PRE_HISTORY_IDX = -1 as NativeMessageIdx;
