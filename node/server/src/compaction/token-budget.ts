export type BudgetDecision = { type: "proceed" } | { type: "stop" };

/** When a thread's request is too large to send, and what it continues with
 * after compacting. Plain configuration: it survives core replacement and is
 * copied onto forks. */
export class TokenBudget {
  static create(opts: { threshold?: number; handoff: string }): TokenBudget {
    const threshold = opts.threshold ?? 300000;
    if (!Number.isInteger(threshold) || threshold <= 0)
      throw new Error(
        `autoCompactThreshold must be a positive integer, got ${threshold}`,
      );
    return new TokenBudget(threshold, opts.handoff);
  }

  static clone(args: { source: TokenBudget }): TokenBudget {
    return new TokenBudget(args.source.threshold, args.source.handoff);
  }

  private constructor(
    readonly threshold: number,
    readonly handoff: string,
  ) {}

  check(inputTokenCount: number): BudgetDecision {
    return inputTokenCount >= this.threshold
      ? { type: "stop" }
      : { type: "proceed" };
  }
}
