import { describe, expect, it, vi } from "vitest";
import type {
  BufNr,
  CommentLocation,
  CommentUpdateEntry,
} from "./comment-store.ts";
import { CommentStore } from "./comment-store.ts";
import { CommentSupervisor } from "./comment-supervisor.ts";

function loc(): CommentLocation {
  return {
    bufferLabel: "node/foo.ts",
    bufnr: 4 as BufNr,
    lines: { start: 41, end: 42 },
    selection: "  const x = compute();",
    state: "anchored",
  };
}

describe("CommentSupervisor", () => {
  it("runs beforeRead before reading the store, then delivers and commits", async () => {
    const store = new CommentStore();
    const order: string[] = [];
    const onSent = vi.fn<(entries: CommentUpdateEntry[]) => void>();
    const supervisor = new CommentSupervisor({
      store,
      beforeRead: () => {
        order.push("beforeRead");
        store.addComment(loc(), "why is this recomputed?");
        return Promise.resolve();
      },
      onSent,
    });

    const action = await supervisor.onBeforeRequest({
      kind: "submission",
      inputTokenCount: 0,
      isFirstMessage: false,
      outputTokenCount: 0,
    });
    order.push("read");
    expect(order).toEqual(["beforeRead", "read"]);

    if (action.type !== "inject") throw new Error("expected inject");
    const block = action.content[0];
    if (block.type !== "text") throw new Error("expected text");
    expect(block.text).toContain("why is this recomputed?");

    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onSent.mock.calls[0][0]).toHaveLength(1);
    expect(store.hasPendingUpdates()).toBe(false);
  });

  it("yields nothing when no comments are pending", async () => {
    const store = new CommentStore();
    const onSent = vi.fn<(entries: CommentUpdateEntry[]) => void>();
    const supervisor = new CommentSupervisor({
      store,
      beforeRead: () => Promise.resolve(),
      onSent,
    });
    expect(
      (
        await supervisor.onBeforeRequest({
          kind: "submission",
          inputTokenCount: 0,
          isFirstMessage: false,
          outputTokenCount: 0,
        })
      ).type,
    ).toBe("none");
    expect(onSent).not.toHaveBeenCalled();
  });
});
