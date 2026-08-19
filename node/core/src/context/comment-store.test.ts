import { describe, expect, it } from "vitest";
import {
  type BufNr,
  type CommentLocation,
  CommentStore,
} from "./comment-store.ts";

type LocOverrides = Partial<Omit<CommentLocation, "lines">> & {
  lines?: CommentLocation["lines"] | undefined;
};

function loc(overrides: LocOverrides = {}): CommentLocation {
  return {
    bufferLabel: "node/foo.ts",
    bufnr: 4 as BufNr,
    lines: { start: 41, end: 42 },
    selection: "  const x = compute();",
    state: "anchored",
    ...overrides,
  };
}

function text(store: CommentStore): string {
  const parts = store.getPendingUpdate();
  if (parts.length === 0) return "";
  const part = parts[0];
  if (part.type !== "text") throw new Error("expected text");
  return part.text;
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

    expect(store.getPendingUpdate()).toHaveLength(1);
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
    expect(store.getPendingUpdate()).toEqual([]);

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
    expect(store.getPendingUpdate()).toEqual([]);
  });

  it("errors on a reply to an unknown comment", () => {
    const store = new CommentStore();
    const result = store.addAgentMessage("c99" as never, "hi");
    expect(result.status).toBe("error");
  });

  it("reports a stale location", () => {
    const store = new CommentStore();
    const id = store.addComment(loc(), "why?");
    store.setLocation(
      id,
      loc({ lines: undefined, state: "stale", selection: "" }),
    );
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
    expect(store.getPendingUpdate()).toEqual([]);
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

  it("reports the current location, not the one at creation", () => {
    const store = new CommentStore();
    const id = store.addComment(loc(), "why?");
    store.setLocation(id, loc({ lines: { start: 60, end: 60 } }));
    expect(text(store)).toContain(`${id} node/foo.ts:60 (1 new message)`);
  });
});
