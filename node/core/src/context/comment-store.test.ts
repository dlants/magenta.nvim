import { describe, expect, it } from "vitest";
import {
  type BufNr,
  type CommentLocation,
  CommentStore,
} from "./comment-store.ts";

type AnchoredLocation = Extract<CommentLocation, { state: "anchored" }>;

function loc(overrides: Partial<AnchoredLocation> = {}): CommentLocation {
  return {
    bufferLabel: "node/foo.ts",
    bufnr: 4 as BufNr,
    lines: { start: 41, end: 42 },
    selection: "  const x = compute();",
    state: "anchored",
    ...overrides,
  };
}

function staleLoc(): CommentLocation {
  return {
    bufferLabel: "node/foo.ts",
    bufnr: 4 as BufNr,
    state: "stale",
  };
}

function text(store: CommentStore): string {
  return store.getPendingUpdate() ?? "";
}

describe("CommentStore", () => {
  it("builds a single comment_update block with a manifest and body", () => {
    const store = new CommentStore();
    const id = store.addComment(loc(), "why is this recomputed?");

    const out = text(store);
    expect(out).toContain("<comment_update>");
    expect(out).toContain(`${id} node/foo.ts:41-42 (1 new message)`);
    expect(out).toContain(`- \`${id}\` buffer 4 \`node/foo.ts\` lines 41-42`);
    expect(out).toContain("<selection>\n  const x = compute();\n</selection>");
    expect(out).toContain("<user>why is this recomputed?</user>");
  });

  it("batches multiple comments into one part in submission order", () => {
    const store = new CommentStore();
    const a = store.addComment(loc(), "first");
    const b = store.addComment(loc({ bufferLabel: "node/bar.ts" }), "second");

    expect(store.getPendingUpdate()).toBeDefined();
    const out = text(store);
    expect(out.indexOf(`${a} node/foo.ts`)).toBeLessThan(
      out.indexOf(`${b} node/bar.ts`),
    );
  });

  it("delivers each message exactly once", () => {
    const store = new CommentStore();
    const id = store.addComment(loc(), "first");
    expect(store.pendingCommentIds()).toEqual([id]);

    const entries = store.commitPending();
    expect(entries).toMatchObject([{ commentId: id, status: "new-messages" }]);
    expect(store.pendingCommentIds()).toEqual([]);
    expect(store.getPendingUpdate()).toBeUndefined();

    store.addUserMessage(id, "follow up");
    expect(text(store)).toContain("<user>follow up</user>");
    expect(text(store)).not.toContain("<user>first</user>");
  });

  it("does not queue agent replies for delivery", () => {
    const store = new CommentStore();
    const id = store.addComment(loc(), "first");
    store.commitPending();

    expect(store.addAgentMessage(id, "because…")).toEqual({
      status: "ok",
      value: undefined,
    });
    expect(store.comments[id].messages).toHaveLength(2);
    expect(store.getPendingUpdate()).toBeUndefined();
  });

  it("errors on a reply to an unknown comment", () => {
    const store = new CommentStore();
    const result = store.addAgentMessage("c99" as never, "hi");
    expect(result.status).toBe("error");
  });

  it("reports a stale location", () => {
    const store = new CommentStore();
    const id = store.addComment(loc(), "why?");
    store.setLocation(id, staleLoc());
    const out = text(store);
    expect(out).toContain("(range deleted)");
    expect(out).toContain("the commented range was deleted");
  });

  it("queues terminal notices and drops the comment", () => {
    const store = new CommentStore();
    const id = store.addComment(loc(), "why?");
    store.commitPending();

    store.closeComment(id, "deleted");
    expect(store.listOpenCommentIds()).toEqual([]);
    expect(text(store)).toContain(`${id} node/foo.ts:41-42 (deleted)`);

    store.commitPending();
    expect(store.getPendingUpdate()).toBeUndefined();
  });

  it("reports an unloaded buffer as closed", () => {
    const store = new CommentStore();
    const id = store.addComment(loc(), "why?");
    store.commitPending();
    store.closeComment(id, "buffer-unloaded");
    expect(text(store)).toContain(
      `${id} node/foo.ts:41-42 (closed: buffer unloaded)`,
    );
  });

  it("still delivers undelivered messages when a comment is closed", () => {
    const store = new CommentStore();
    const id = store.addComment(loc(), "why?");

    store.closeComment(id, "deleted");
    const out = text(store);
    expect(out).toContain(`${id} node/foo.ts:41-42 (1 new message)`);
    expect(out).toContain(`${id} node/foo.ts:41-42 (deleted)`);
    expect(out).toContain("<user>why?</user>");
    expect(out.indexOf("(1 new message)")).toBeLessThan(
      out.indexOf("(deleted)"),
    );
  });

  it("mixes new-message and close entries in one block", () => {
    const store = new CommentStore();
    const a = store.addComment(loc(), "first");
    store.commitPending();
    const b = store.addComment(loc({ bufferLabel: "node/bar.ts" }), "second");
    store.closeComment(a, "buffer-unloaded");

    const out = text(store);
    expect(out).toContain(`${a} node/foo.ts:41-42 (closed: buffer unloaded)`);
    expect(out).toContain(`${b} node/bar.ts:41-42 (1 new message)`);
    // only the open comment gets a body
    expect(out).toContain(`- \`${b}\``);
    expect(out).not.toContain(`- \`${a}\``);
  });

  it("reports the current location, not the one at creation", () => {
    const store = new CommentStore();
    const id = store.addComment(loc(), "why?");
    store.setLocation(id, loc({ lines: { start: 60, end: 60 } }));
    expect(text(store)).toContain(`${id} node/foo.ts:60 (1 new message)`);
  });
});
