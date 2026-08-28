import type { Comment, CommentMessage } from "@magenta/core";
import { MAGENTA_COMMENT_NAMESPACE, type NvimBuffer } from "../nvim/buffer.ts";
import type { ExtmarkOptions, HLGroup } from "../nvim/extmarks.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import { spinnerFrame } from "../spinner.ts";
import { pos } from "../tea/view.ts";

export const COMMENT_SIGN = "💬";

/** Virtual text does not wrap, so long messages would run off the window.
 * Wrap them ourselves at a comfortable reading width. */
export const MAX_COMMENT_WIDTH = 80;

/** Greedy word wrap, breaking words longer than `width` mid-word. */
function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  let current = "";
  for (let word of text.split(/ /)) {
    while (word.length > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (current === "") {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

const AUTHOR_HL: { [from in CommentMessage["from"]]: HLGroup } = {
  user: "Identifier",
  agent: "Function",
};

/** What the agent is doing about this particular comment right now, as read
 * off the live turn. `replying` carries the reply text parsed out of the
 * still-streaming `reply` tool input. */
export type CommentActivity =
  | { type: "thinking" }
  | { type: "replying"; text: string };

/** One message, wrapped, as `prefix: text` virtual lines. */
function messageLines(
  from: CommentMessage["from"],
  text: string,
): Array<Array<[string, HLGroup]>> {
  const prefix = from === "user" ? "  you: " : "  agent: ";
  const hl = AUTHOR_HL[from];
  return text
    .split("\n")
    .flatMap((line) => wrap(line, MAX_COMMENT_WIDTH - prefix.length))
    .map((line, i) => [
      [i === 0 ? prefix : " ".repeat(prefix.length), "Comment"] as [
        string,
        HLGroup,
      ],
      [line, hl] as [string, HLGroup],
    ]);
}

export type CommentExtent = { startRow: Row0Indexed; endRow: Row0Indexed };

/**
 * The whole exchange, one virtual line per line of message text. `pending`
 * marks messages the agent has not been sent yet.
 */
export function commentVirtLines({
  comment,
  pending,
  maxMessages,
  activity,
}: {
  comment: Comment;
  pending: boolean;
  /** When set, render only the last N messages plus an elision line. */
  maxMessages?: number | undefined;
  activity?: CommentActivity | undefined;
}): Array<Array<[string, HLGroup]>> {
  const lines: Array<Array<[string, HLGroup]>> = [];

  let messages = comment.messages;
  if (maxMessages !== undefined && messages.length > maxMessages) {
    const elided = messages.length - maxMessages;
    messages = messages.slice(-maxMessages);
    lines.push([
      [`  … ${elided} earlier message${elided === 1 ? "" : "s"}`, "Comment"],
    ]);
  }

  if (comment.location.state === "stale") {
    lines.push([["  (stale: the commented range was deleted)", "ErrorMsg"]]);
  }

  for (const message of messages) {
    lines.push(...messageLines(message.from, message.text));
  }

  if (activity) {
    const streamed = activity.type === "replying" ? activity.text : "";
    lines.push(...messageLines("agent", `${streamed}${spinnerFrame()}`));
  }

  if (pending) {
    lines.push([["  (pending)", "Comment"]]);
  }

  return lines;
}

/**
 * Highlight a range that is about to become a comment, so the user can see
 * what they selected while the input is open. Lives in the render namespace,
 * so a refresh drops it unless the controller re-stamps it.
 */
export async function renderPreview(
  buffer: NvimBuffer,
  extent: CommentExtent,
): Promise<void> {
  for (let row = extent.startRow; row <= extent.endRow; row++) {
    await buffer.setExtmark({
      startPos: pos(row, 0),
      endPos: pos(row, 0),
      options: { line_hl_group: "CursorLine", priority: 100 },
      namespace: MAGENTA_COMMENT_NAMESPACE,
    });
  }
}

/**
 * Stamp a comment's decoration into the render namespace. Idempotent given a
 * cleared namespace: everything drawn here is derived from the store.
 */
export async function renderComment({
  buffer,
  comment,
  extent,
  pending,
  maxMessages,
  activity,
}: {
  buffer: NvimBuffer;
  comment: Comment;
  extent: CommentExtent;
  pending: boolean;
  maxMessages?: number | undefined;
  activity?: CommentActivity | undefined;
}): Promise<void> {
  for (let row = extent.startRow; row <= extent.endRow; row++) {
    const options: ExtmarkOptions = {
      line_hl_group: "CursorLine",
      priority: 100,
    };
    if (row === extent.startRow) {
      options.sign_text = COMMENT_SIGN;
      options.sign_hl_group = "Identifier";
    }
    await buffer.setExtmark({
      startPos: pos(row, 0),
      endPos: pos(row, 0),
      options,
      namespace: MAGENTA_COMMENT_NAMESPACE,
    });
  }

  await buffer.setExtmark({
    startPos: pos(extent.endRow, 0),
    endPos: pos(extent.endRow, 0),
    options: {
      virt_lines: commentVirtLines({ comment, pending, maxMessages, activity }),
      priority: 100,
    },
    namespace: MAGENTA_COMMENT_NAMESPACE,
  });
}
