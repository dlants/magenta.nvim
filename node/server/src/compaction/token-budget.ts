export type BudgetDecision = { type: "proceed" } | { type: "stop" };

/** When a thread's request is too large to send, and what it continues with
 * after compacting. Plain configuration: it survives core replacement and is
 * copied onto forks. */
export class TokenBudget {
  static create(opts: { threshold?: number; handoff: string }): TokenBudget {
    return new TokenBudget(opts.threshold ?? 300000, opts.handoff);
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
