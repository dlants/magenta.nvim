import { describe, expect, it } from "vitest";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "../providers/provider-types.ts";
import { pendingMessage, renderPending } from "./index.ts";
import { Mailbox, type QueueEntry, submissionEntries } from "./mailbox.ts";

const raw = (text: string): QueueEntry => ({
  type: "raw",
  message: pendingMessage(text),
});

describe("Mailbox", () => {
  it("detaches a synchronous batch and prepends leftovers ahead of new arrivals", () => {
    const mailbox = new Mailbox();
    mailbox.enqueue("async", [raw("first"), raw("second")]);
    const batch = mailbox.takeBatch("async");
    mailbox.enqueue("async", [raw("later")]);
    expect(batch).toEqual([raw("first"), raw("second")]);
    expect(mailbox.queues.async).toEqual([raw("later")]);
    mailbox.prepend("async", batch.slice(1));
    mailbox.enqueue("next", [raw("@compact untouched")]);
    expect(mailbox.drain()).toEqual([
      { when: "async", message: raw("second") },
      { when: "async", message: raw("later") },
      { when: "next", message: raw("@compact untouched") },
    ]);
    expect(mailbox.queues).toEqual({ async: [], next: [] });
    expect(mailbox.drain()).toEqual([]);
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
