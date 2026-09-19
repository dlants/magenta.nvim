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

/** One checked-out queue batch. The entry handed out by `next` is already
 * consumed by the caller; only untouched entries are restorable. */
export type Batch = {
  readonly delivery: DeferredDelivery;
  next(): QueueEntry | undefined;
  /** Put the untaken remainder back at the head of `to` (its own queue by
   * default) and end the checkout. */
  restore(to?: DeferredDelivery): void;
  /** End the checkout, discarding nothing: the batch was delivered in full. */
  commit(): void;
};
export class Mailbox {
  private storage: Record<DeferredDelivery, QueueEntry[]> = {
    async: [],
    next: [],
  };
  /** Content prepended for the next turn: resolved, not queued, and so not
   * part of `queues` or `drain`. A reset replaces it wholesale. */
  private seedEntries: AgentInput[] = [];
  private checkedOut: Batch | undefined;
  get queues(): Queues {
    return this.storage;
  }
  get seed(): ReadonlyArray<AgentInput> {
    return this.seedEntries;
  }
  appendSeed(messages: AgentInput[]): void {
    this.seedEntries = [...this.seedEntries, ...messages];
  }
  setSeed(messages: AgentInput[]): void {
    this.seedEntries = [...messages];
  }
  takeSeed(): AgentInput[] {
    const seed = this.seedEntries;
    this.seedEntries = [];
    return seed;
  }
  enqueue(delivery: DeferredDelivery, entries: QueueEntry[]): void {
    this.storage[delivery].push(...entries);
  }
  /** Take a queue in full for delivery. At most one checkout is live: a new
   * one restores whatever the previous caller abandoned. */
  checkout(delivery: DeferredDelivery): Batch {
    this.checkedOut?.restore();
    const remaining = this.storage[delivery];
    this.storage[delivery] = [];
    const batch: Batch = {
      delivery,
      next: () => remaining.shift(),
      restore: (to = delivery) => {
        if (this.checkedOut === batch) this.checkedOut = undefined;
        this.prepend(to, remaining.splice(0));
      },
      commit: () => {
        if (this.checkedOut === batch) this.checkedOut = undefined;
      },
    };
    this.checkedOut = batch;
    return batch;
  }
  /** Hand the live checkout's untouched remainder back, if a delivery is still
   * in flight. */
  restoreCheckout(): void {
    this.checkedOut?.restore();
  }
  prepend(delivery: DeferredDelivery, entries: QueueEntry[]): void {
    this.storage[delivery].unshift(...entries);
  }
  /** Everything queued, in delivery order. A live checkout is restored first,
   * so an in-flight batch's untouched remainder is reported ahead of anything
   * that arrived while it was being resolved. */
  drain(): QueuedMessage[] {
    this.checkedOut?.restore();
    return (["async", "next"] as const).flatMap((when) => {
      const entries = this.storage[when];
      this.storage[when] = [];
      return entries.map((message) => ({ when, message }));
    });
  }
}
