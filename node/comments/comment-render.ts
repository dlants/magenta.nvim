import type { Comment, CommentMessage } from "@magenta/core";
import { MAGENTA_COMMENT_NAMESPACE, type NvimBuffer } from "../nvim/buffer.ts";
import type { ExtmarkOptions, HLGroup } from "../nvim/extmarks.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import { pos } from "../tea/view.ts";

export const COMMENT_SIGN = "💬";

const AUTHOR_HL: { [from in CommentMessage["from"]]: HLGroup } = {
  user: "Identifier",
  agent: "Function",
};

export type CommentExtent = { startRow: Row0Indexed; endRow: Row0Indexed };

/**
 * The whole exchange, one virtual line per line of message text. `pending`
 * marks messages the agent has not been sent yet.
 */
export function commentVirtLines({
  comment,
  pending,
  maxMessages,
}: {
  comment: Comment;
  pending: boolean;
  /** When set, render only the last N messages plus an elision line. */
  maxMessages?: number | undefined;
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
    const prefix = message.from === "user" ? "  you: " : "  agent: ";
    const hl = AUTHOR_HL[message.from];
    const textLines = message.text.split("\n");
    textLines.forEach((text, i) => {
      lines.push([
        [i === 0 ? prefix : " ".repeat(prefix.length), "Comment"],
        [text, hl],
      ]);
    });
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
}: {
  buffer: NvimBuffer;
  comment: Comment;
  extent: CommentExtent;
  pending: boolean;
  maxMessages?: number | undefined;
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
      virt_lines: commentVirtLines({ comment, pending, maxMessages }),
      priority: 100,
    },
    namespace: MAGENTA_COMMENT_NAMESPACE,
  });
}
