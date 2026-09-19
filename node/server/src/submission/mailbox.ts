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

/** What to do with a delivery's untouched remainder when the run ends. */
export type BatchDisposition =
  | { type: "commit" }
  | {
      type: "restore";
      /** Queue to restore into; the batch's own queue by default. */
      to?: DeferredDelivery;
      /** Entries to put ahead of the restored remainder. */
      ahead?: QueueEntry[];
    };
export type BatchRun<T> = (
  next: () => QueueEntry | undefined,
) => Promise<{ disposition: BatchDisposition; value: T }>;
type Checkout = {
  readonly delivery: DeferredDelivery;
  readonly remaining: QueueEntry[];
  closed: boolean;
};
export class Mailbox {
  private storage: Record<DeferredDelivery, QueueEntry[]> = {
    async: [],
    next: [],
  };
  /** Content prepended for the next turn: resolved, not queued, and so not
   * part of `queues` or `drain`. A reset replaces it wholesale. */
  private seedEntries: AgentInput[] = [];
  private checkedOut: Checkout | undefined;
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
  /** Take a queue in full for the duration of `run`, which sees only a `next`
   * cursor and says at the end whether the untouched remainder is spent
   * (`commit`) or goes back on a queue (`restore`). The checkout cannot
   * outlive the run, so there is no handle to misuse afterwards.
   *
   * At most one checkout is live: starting one, draining, or an explicit
   * `restoreCheckout` ends whatever was in flight, after which its `next`
   * yields nothing and its disposition is a no-op. */
  async deliver<T>(delivery: DeferredDelivery, run: BatchRun<T>): Promise<T> {
    this.restoreCheckout();
    const checkout: Checkout = {
      delivery,
      remaining: this.storage[delivery],
      closed: false,
    };
    this.storage[delivery] = [];
    this.checkedOut = checkout;
    const next = () =>
      checkout.closed ? undefined : checkout.remaining.shift();
    let disposition: BatchDisposition = { type: "restore" };
    try {
      const outcome = await run(next);
      disposition = outcome.disposition;
      return outcome.value;
    } finally {
      if (!checkout.closed) {
        checkout.closed = true;
        this.checkedOut = undefined;
        if (disposition.type === "restore") {
          this.prepend(disposition.to ?? delivery, [
            ...(disposition.ahead ?? []),
            ...checkout.remaining.splice(0),
          ]);
        }
      }
    }
  }
  /** Hand the live checkout's untouched remainder back, if a delivery is still
   * in flight. */
  restoreCheckout(): void {
    const checkout = this.checkedOut;
    if (!checkout) return;
    checkout.closed = true;
    this.checkedOut = undefined;
    this.prepend(checkout.delivery, checkout.remaining.splice(0));
  }
  prepend(delivery: DeferredDelivery, entries: QueueEntry[]): void {
    this.storage[delivery].unshift(...entries);
  }
  /** Everything queued, in delivery order. A live checkout is restored first,
   * so an in-flight batch's untouched remainder is reported ahead of anything
   * that arrived while it was being resolved. */
  drain(): QueuedMessage[] {
    this.restoreCheckout();
    return (["async", "next"] as const).flatMap((when) => {
      const entries = this.storage[when];
      this.storage[when] = [];
      return entries.map((message) => ({ when, message }));
    });
  }
}
