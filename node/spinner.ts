const SPINNER_FRAMES = ["⠁", "⠂", "⠄", "⠂"];

/** Wall-clock driven spinner frame. Anchoring to the wall clock rather than a
 * start time keeps every spinner on screen in phase, and lets callers that
 * have no start time animate. */
export function spinnerFrame(since?: Date): string {
  const elapsed = since ? Date.now() - since.getTime() : Date.now();
  return SPINNER_FRAMES[Math.floor(elapsed / 333) % SPINNER_FRAMES.length];
}
