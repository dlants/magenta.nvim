import { describe, expect, it } from "vitest";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "../providers/provider-types.ts";
import { pendingMessage, renderPending } from "./index.ts";
import { Mailbox, type QueueEntry, submissionEntries } from "./mailbox.ts";

const raw = (text: string): QueueEntry => ({
  type: "raw",
  message: pendingMessage(text),
});

describe("Mailbox", () => {
  it("checks out a batch and restores leftovers ahead of new arrivals", async () => {
    const mailbox = new Mailbox();
    mailbox.enqueueAsync([raw("first"), raw("second")]);
    await mailbox.deliverAsync(async (next) => {
      mailbox.enqueueAsync([raw("later")]);
      expect(next()).toEqual(raw("first"));
      expect(mailbox.queues.async).toEqual([raw("later")]);
      return { disposition: { type: "restore" }, value: undefined };
    });
    mailbox.enqueueNext([raw("@compact untouched")]);
    expect(mailbox.drain()).toEqual([
      { when: "async", message: raw("second") },
      { when: "async", message: raw("later") },
      { when: "next", message: raw("@compact untouched") },
    ]);
    expect(mailbox.queues).toEqual({ async: [], next: [] });
    expect(mailbox.drain()).toEqual([]);
  });
  it("restores an abandoned checkout when the queues are drained", async () => {
    const mailbox = new Mailbox();
    mailbox.enqueueAsync([raw("first"), raw("second")]);
    await mailbox.deliverAsync(async (next) => {
      expect(next()).toEqual(raw("first"));
      mailbox.enqueueAsync([raw("later")]);
      expect(mailbox.drain()).toEqual([
        { when: "async", message: raw("second") },
        { when: "async", message: raw("later") },
      ]);
      expect(next()).toBeUndefined();
      return { disposition: { type: "commit" }, value: undefined };
    });
    expect(mailbox.drain()).toEqual([]);
  });
  it("moves an async checkout onto the next queue, in order", async () => {
    const mailbox = new Mailbox();
    mailbox.enqueueAsync([raw("first"), raw("@compact"), raw("third")]);
    mailbox.enqueueNext([raw("already queued")]);
    await mailbox.deliverAsync(async (next) => {
      next();
      const compact = next();
      return {
        disposition: { type: "deferToNext", ahead: compact ? [compact] : [] },
        value: undefined,
      };
    });
    expect(mailbox.queues.next).toEqual([
      raw("@compact"),
      raw("third"),
      raw("already queued"),
    ]);
    expect(mailbox.queues.async).toEqual([]);
  });

  it("closes a live checkout when another one opens, restoring its own queue", async () => {
    const mailbox = new Mailbox();
    mailbox.enqueueAsync([raw("async first"), raw("async second")]);
    mailbox.enqueueNext([raw("next first")]);
    let asyncCursor: (() => QueueEntry | undefined) | undefined;
    const asyncRun = mailbox.deliverAsync<undefined>(
      (next) =>
        new Promise(() => {
          asyncCursor = next;
          next();
        }),
    );
    await Promise.resolve();
    expect(asyncCursor).toBeDefined();
    await mailbox.deliverNext(async (next) => {
      expect(next()).toEqual(raw("next first"));
      return { disposition: { type: "commit" }, value: undefined };
    });
    // The abandoned async remainder goes back to the async queue, not to next.
    expect(mailbox.queues.async).toEqual([raw("async second")]);
    expect(mailbox.queues.next).toEqual([]);
    expect(asyncCursor?.()).toBeUndefined();
    void asyncRun;
  });

  it("normalizes raw and resolved inputs without interpreting their content", () => {
    expect(
      submissionEntries({ type: "raw", message: pendingMessage("@compact") }),
    ).toEqual([raw("@compact")]);
    const input = {
      type: "text" as const,
      text: "@compact",
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    };
    const entries = submissionEntries({ type: "resolved", messages: [input] });
    expect(entries).toEqual([{ type: "resolved", input }]);
    expect(renderPending(entries[0])).toBe("@compact");
    expect(renderPending(raw("@compact"))).toBe("@compact");
    expect(submissionEntries({ type: "resolved", messages: [] })).toEqual([]);
  });
});
