import type { Comment, CommentId, CommentMessage } from "@magenta/core";
import { describe, expect, it } from "vitest";
import type { BufNr } from "../nvim/buffer.ts";
import { commentVirtLines } from "./comment-render.ts";

function comment(count: number): Comment {
  const messages: CommentMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({ from: i % 2 === 0 ? "user" : "agent", text: `m${i}` });
  }
  return {
    id: "c1" as CommentId,
    location: {
      bufferLabel: "node/foo.ts",
      bufnr: 1 as BufNr,
      lines: { start: 1, end: 1 },
      selection: "x",
      state: "anchored",
    },
    messages,
  };
}

const texts = (lines: Array<Array<[string, string]>>) =>
  lines.map((line) => line.map(([text]) => text).join(""));

describe("commentVirtLines", () => {
  it("renders every message when maxMessages is unset", () => {
    expect(
      texts(commentVirtLines({ comment: comment(3), pending: false })),
    ).toEqual(["  you: m0", "  agent: m1", "  you: m2"]);
  });

  it("elides all but the last N messages", () => {
    const lines = texts(
      commentVirtLines({ comment: comment(5), pending: false, maxMessages: 2 }),
    );
    expect(lines).toEqual([
      "  … 3 earlier messages",
      "  agent: m3",
      "  you: m4",
    ]);
  });

  it("uses the singular at exactly one elided message", () => {
    const lines = texts(
      commentVirtLines({ comment: comment(3), pending: false, maxMessages: 2 }),
    );
    expect(lines[0]).toEqual("  … 1 earlier message");
  });

  it("does not elide at exactly maxMessages", () => {
    const lines = texts(
      commentVirtLines({ comment: comment(2), pending: false, maxMessages: 2 }),
    );
    expect(lines).toEqual(["  you: m0", "  agent: m1"]);
  });
});
