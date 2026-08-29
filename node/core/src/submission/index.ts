import type { InputMessage } from "../agent.ts";

/** When a parsed submission is delivered.
 * - `now`: abort whatever is running and send immediately
 * - `async`: inject into the current turn at the earliest opportunity (@async)
 * - `next`: wait until the agent next stops (@next) */
export type Delivery = "now" | "async" | "next";

/** The raw user text of a submission, after its delivery prefix has been
 * stripped but before any of its commands (`@compact`, `@file:`, `@diff`, ...)
 * have run.
 */
export type PendingMessage = string & { __pendingMessage: true };

export function pendingMessage(text: string): PendingMessage {
  return text as PendingMessage;
}

/** The display string for a queued entry whose commands have not run yet. */
export function renderPending(message: PendingMessage): string {
  return message;
}

/** When a submission should be delivered, and what to deliver. */
export type Submission = {
  delivery: Delivery;
  message: PendingMessage;
};

export type ResolvedSubmission = {
  compact: boolean;
  messages: InputMessage[];
  reminders: string[];
};

export function compactPrompt(
  resolved: ResolvedSubmission,
): string | undefined {
  const text = resolved.messages
    .map((m) => m.text)
    .join("\n")
    .trim();
  return text || undefined;
}

export type ResolveSubmission = (
  message: PendingMessage,
) => Promise<ResolvedSubmission>;

/** Used by threads whose content is composed programmatically (subagents, scripts). */
export const resolveAsText: ResolveSubmission = (message) =>
  Promise.resolve({
    compact: false,
    messages: message.length ? [{ type: "user", text: message }] : [],
    reminders: [],
  });

const COMPACT_PREFIX = /^\s*@compact(?!\w)\s*/;
const ASYNC_PREFIX = /^\s*@async(?!\w)\s*/;
const NEXT_PREFIX = /^\s*@next(?!\w)\s*/;

export function parseDelivery(text: string): Submission {
  if (ASYNC_PREFIX.test(text)) {
    return {
      delivery: "async",
      message: pendingMessage(text.replace(ASYNC_PREFIX, "")),
    };
  }
  if (NEXT_PREFIX.test(text)) {
    return {
      delivery: "next",
      message: pendingMessage(text.replace(NEXT_PREFIX, "")),
    };
  }
  return { delivery: "now", message: pendingMessage(text) };
}

export function parseCompact(message: PendingMessage): {
  compact: boolean;
  rest: PendingMessage;
} {
  if (!COMPACT_PREFIX.test(message)) {
    return { compact: false, rest: message };
  }
  const rest = message.replace(COMPACT_PREFIX, "").trim();
  return { compact: true, rest: pendingMessage(rest) };
}
