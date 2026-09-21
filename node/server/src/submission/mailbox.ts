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
export type Disposition = { type: "commit" } | { type: "restore" };
/** The async queue drains into a request that already exists, so it has one
 * extra outcome: content that cannot ride that request — and everything
 * behind it — moves to `next`. */
export type AsyncDisposition =
  | Disposition
  | { type: "deferToNext"; ahead: QueueEntry[] };
export type BatchRun<T, D extends AsyncDisposition> = (
  next: () => QueueEntry | undefined,
) => Promise<{ disposition: D; value: T }>;
type Checkout = {
  readonly remaining: QueueEntry[];
  /** Where the untouched remainder goes when the run does not commit it. */
  readonly restore: (entries: QueueEntry[]) => void;
  closed: boolean;
};
export class Mailbox {
  private asyncQueue: QueueEntry[] = [];
  private nextQueue: QueueEntry[] = [];
  private checkedOut: Checkout | undefined;
  get queues(): Queues {
    return { async: this.asyncQueue, next: this.nextQueue };
  }
  enqueueAsync(entries: QueueEntry[]): void {
    this.asyncQueue.push(...entries);
  }
  enqueueNext(entries: QueueEntry[]): void {
    this.nextQueue.push(...entries);
  }
  /** Take the async queue in full for the duration of `run`, which sees only
   * a `next` cursor and says at the end whether the untouched remainder is
   * spent (`commit`), goes back (`restore`), or moves to the `next` queue.
   *
   * At most one checkout is live: starting one, draining, or an explicit
   * `restoreCheckout` ends whatever was in flight, after which its `next`
   * yields nothing and its disposition is a no-op. */
  async deliverAsync<T>(run: BatchRun<T, AsyncDisposition>): Promise<T> {
    const checkout = this.open(this.asyncQueue.splice(0), (entries) =>
      this.asyncQueue.unshift(...entries),
    );
    let disposition: AsyncDisposition = { type: "restore" };
    try {
      const outcome = await run(this.cursor(checkout));
      disposition = outcome.disposition;
      return outcome.value;
    } finally {
      if (!checkout.closed) {
        this.close(checkout);
        if (disposition.type === "deferToNext") {
          this.nextQueue.unshift(
            ...disposition.ahead,
            ...checkout.remaining.splice(0),
          );
        } else if (disposition.type === "restore") {
          checkout.restore(checkout.remaining.splice(0));
        }
      }
    }
  }
  /** The `next` queue's equivalent: it only ever drains into a request that
   * does not exist yet, so its remainder is either spent or goes back. */
  async deliverNext<T>(run: BatchRun<T, Disposition>): Promise<T> {
    const checkout = this.open(this.nextQueue.splice(0), (entries) =>
      this.nextQueue.unshift(...entries),
    );
    let disposition: Disposition = { type: "restore" };
    try {
      const outcome = await run(this.cursor(checkout));
      disposition = outcome.disposition;
      return outcome.value;
    } finally {
      if (!checkout.closed) {
        this.close(checkout);
        if (disposition.type === "restore")
          checkout.restore(checkout.remaining.splice(0));
      }
    }
  }
  private open(
    remaining: QueueEntry[],
    restore: (entries: QueueEntry[]) => void,
  ): Checkout {
    this.restoreCheckout();
    const checkout: Checkout = { remaining, restore, closed: false };
    this.checkedOut = checkout;
    return checkout;
  }
  private cursor(checkout: Checkout): () => QueueEntry | undefined {
    return () => (checkout.closed ? undefined : checkout.remaining.shift());
  }
  private close(checkout: Checkout): void {
    checkout.closed = true;
    this.checkedOut = undefined;
  }
  /** Hand the live checkout's untouched remainder back, if a delivery is still
   * in flight. */
  restoreCheckout(): void {
    const checkout = this.checkedOut;
    if (!checkout) return;
    this.close(checkout);
    checkout.restore(checkout.remaining.splice(0));
  }
  /** Everything queued, in delivery order. A live checkout is restored first,
   * so an in-flight batch's untouched remainder is reported ahead of anything
   * that arrived while it was being resolved. */
  drain(): QueuedMessage[] {
    this.restoreCheckout();
    return [
      ...this.asyncQueue
        .splice(0)
        .map((message): QueuedMessage => ({ when: "async", message })),
      ...this.nextQueue
        .splice(0)
        .map((message): QueuedMessage => ({ when: "next", message })),
    ];
  }
}
