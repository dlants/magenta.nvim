import { describe, expect, it } from "vitest";
import { TokenBudget } from "./token-budget.ts";

describe("TokenBudget", () => {
  it("stops at or over the threshold", () => {
    const budget = TokenBudget.create({ threshold: 100, handoff: "go" });
    expect(budget.check(99)).toEqual({ type: "proceed" });
    expect(budget.check(100)).toEqual({ type: "stop" });
  });
  it("defaults the threshold to 300000", () => {
    const budget = TokenBudget.create({ handoff: "go" });
    expect(budget.check(299999)).toEqual({ type: "proceed" });
    expect(budget.check(300000)).toEqual({ type: "stop" });
  });
  it("clones threshold and handoff", () => {
    const clone = TokenBudget.clone({
      source: TokenBudget.create({ threshold: 123, handoff: "later" }),
    });
    expect(clone.threshold).toBe(123);
    expect(clone.handoff).toBe("later");
  });
});
