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
    mailbox.enqueue("async", [raw("first"), raw("second")]);
    await mailbox.deliver("async", async (next) => {
      mailbox.enqueue("async", [raw("later")]);
      expect(next()).toEqual(raw("first"));
      expect(mailbox.queues.async).toEqual([raw("later")]);
      return { disposition: { type: "restore" }, value: undefined };
    });
    mailbox.enqueue("next", [raw("@compact untouched")]);
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
    mailbox.enqueue("async", [raw("first"), raw("second")]);
    await mailbox.deliver("async", async (next) => {
      expect(next()).toEqual(raw("first"));
      mailbox.enqueue("async", [raw("later")]);
      expect(mailbox.drain()).toEqual([
        { when: "async", message: raw("second") },
        { when: "async", message: raw("later") },
      ]);
      expect(next()).toBeUndefined();
      return { disposition: { type: "commit" }, value: undefined };
    });
    expect(mailbox.drain()).toEqual([]);
  });
  it("restores a checkout onto another queue, in order", async () => {
    const mailbox = new Mailbox();
    mailbox.enqueue("async", [raw("first"), raw("@compact"), raw("third")]);
    mailbox.enqueue("next", [raw("already queued")]);
    await mailbox.deliver("async", async (next) => {
      next();
      const compact = next();
      return {
        disposition: {
          type: "restore",
          to: "next",
          ahead: compact ? [compact] : [],
        },
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
  it("keeps seed content out of the queues", () => {
    const mailbox = new Mailbox();
    const input = {
      type: "text" as const,
      text: "seeded",
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    };
    mailbox.appendSeed([input]);
    expect(mailbox.drain()).toEqual([]);
    expect(mailbox.seed).toEqual([input]);
    expect(mailbox.takeSeed()).toEqual([input]);
    expect(mailbox.seed).toEqual([]);
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
