import type { InputMessage } from "../agent.ts";

/** When a parsed submission is delivered.
 * - `now`: abort whatever is running and send immediately
 * - `async`: inject into the current turn at the earliest opportunity (@async)
 * - `next`: wait until the agent next stops (@next) */
export type Delivery = "now" | "async" | "next";

/** A piece of a submission, as data rather than a thunk, so a queued message
 * can be inspected, rendered and serialized while it waits.
 *
 * Command expansion (`@file:`, `@diff`, ...) is deliberately *not* enumerated
 * here: the set of commands includes user-configured ones that core cannot
 * know about, and their patterns live with the (nvim-specific) implementations
 * that run them. A text part therefore still carries un-expanded command
 * syntax; the owner's `ResolveParts` performs the expansion, and it does so at
 * delivery rather than at parse time. */
export type PendingMessagePart = { type: "text"; text: string };

/** A submission that has been parsed but not resolved. The parts are the only
 * source of truth; the display string is derived (`renderPending`) rather than
 * stored alongside, so the two cannot drift. */
export type PendingMessage = {
  parts: PendingMessagePart[];
};

/** The raw user text of an unresolved submission, for rendering a queued
 * entry before its commands have been expanded. */
export function renderPending(message: PendingMessage): string {
  return message.parts.map((p) => p.text).join("");
}

export type SubmissionIntent =
  | { type: "compact"; nextPrompt: PendingMessage | undefined }
  | { type: "send"; delivery: Delivery; message: PendingMessage };

/** Turn parts into content, running their effects. The implementation is
 * nvim-specific (the quickfix list, the buffer list, the context manager), so
 * it is injected — but it takes data, not closures, so core can drive it in
 * tests with a stub. Called at *delivery*: a message queued with `@next`
 * behind a long turn must see the file and the diff as they are then, not as
 * they were when it was typed. */
export type ResolveParts = (
  parts: ReadonlyArray<PendingMessagePart>,
) => Promise<{ messages: InputMessage[]; reminders: string[] }>;

/** The trivial resolver: parts through as text, no command expansion. Used by
 * threads whose content is composed programmatically (subagents, scripts). */
export const resolvePartsAsText: ResolveParts = (parts) =>
  Promise.resolve({
    messages: parts
      .filter((p) => p.text.length > 0)
      .map((p): InputMessage => ({ type: "user", text: p.text })),
    reminders: [],
  });

export function pendingMessage(text: string): PendingMessage {
  return { parts: [{ type: "text", text }] };
}

const COMPACT_PREFIX = /^\s*@compact(?!\w)\s*/;
const ASYNC_PREFIX = /^\s*@async(?!\w)\s*/;
const NEXT_PREFIX = /^\s*@next(?!\w)\s*/;

/** Decide what a piece of user text *is*: a compaction request, or a send with
 * a delivery. Only the leading prefix is significant — `@async` in the middle
 * of a message is ordinary text.
 *
 * `@compact @async foo` is compaction with `foo` as the follow-up prompt: the
 * delivery of a follow-up prompt is not meaningful, so it is stripped. The
 * reverse order (`@async @compact`) is a plain `@async` send, as before. */
export function parseSubmission(text: string): SubmissionIntent {
  if (COMPACT_PREFIX.test(text)) {
    const rest = text
      .replace(COMPACT_PREFIX, "")
      .replace(ASYNC_PREFIX, "")
      .replace(NEXT_PREFIX, "")
      .trim();
    return {
      type: "compact",
      nextPrompt: rest ? pendingMessage(rest) : undefined,
    };
  }
  if (ASYNC_PREFIX.test(text)) {
    return {
      type: "send",
      delivery: "async",
      message: pendingMessage(text.replace(ASYNC_PREFIX, "")),
    };
  }
  if (NEXT_PREFIX.test(text)) {
    return {
      type: "send",
      delivery: "next",
      message: pendingMessage(text.replace(NEXT_PREFIX, "")),
    };
  }
  return { type: "send", delivery: "now", message: pendingMessage(text) };
}
