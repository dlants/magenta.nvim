import type { AgentInput } from "../providers/provider-types.ts";
import type { PendingMessage, SubmissionInput } from "./index.ts";

export type DeferredDelivery = "async" | "next";
export type QueueEntry =
  | { type: "raw"; message: PendingMessage }
  | { type: "resolved"; input: AgentInput };
export type Queues = {
  readonly async: ReadonlyArray<QueueEntry>;
  readonly next: ReadonlyArray<QueueEntry>;
};
export type QueuedMessage = { when: DeferredDelivery; message: QueueEntry };

export function submissionEntries(input: SubmissionInput): QueueEntry[] {
  return input.type === "raw"
    ? [input]
    : input.messages.map((input) => ({ type: "resolved", input }));
}

export class Mailbox {
  private storage: Record<DeferredDelivery, QueueEntry[]> = {
    async: [],
    next: [],
  };

  get queues(): Queues {
    return this.storage;
  }

  enqueue(delivery: DeferredDelivery, entries: QueueEntry[]): void {
    this.storage[delivery].push(...entries);
  }

  takeBatch(delivery: DeferredDelivery): QueueEntry[] {
    const batch = this.storage[delivery];
    this.storage[delivery] = [];
    return batch;
  }

  prepend(delivery: DeferredDelivery, entries: QueueEntry[]): void {
    this.storage[delivery].unshift(...entries);
  }

  drain(): QueuedMessage[] {
    return (["async", "next"] as const).flatMap((when) =>
      this.takeBatch(when).map((message) => ({ when, message })),
    );
  }
}
