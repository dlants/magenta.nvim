import { describe, expect, it } from "vitest";
import { AutoCompactSupervisor } from "./thread-supervisor.ts";

describe("AutoCompactSupervisor", () => {
  it("returns compact at or over the threshold", () => {
    const sup = new AutoCompactSupervisor({ threshold: 300000 });
    expect(
      sup.onHandoff({ inputTokenCount: 300000, stopReason: "end_turn" }),
    ).toEqual({ type: "compact" });
    expect(
      sup.onHandoff({ inputTokenCount: 400000, stopReason: "end_turn" }),
    ).toEqual({ type: "compact" });
  });

  it("returns none below the threshold", () => {
    const sup = new AutoCompactSupervisor({ threshold: 300000 });
    expect(
      sup.onHandoff({ inputTokenCount: 299999, stopReason: "end_turn" }),
    ).toEqual({ type: "none" });
  });

  it("returns none when inputTokenCount is undefined", () => {
    const sup = new AutoCompactSupervisor({ threshold: 300000 });
    expect(
      sup.onHandoff({ inputTokenCount: undefined, stopReason: "end_turn" }),
    ).toEqual({ type: "none" });
  });

  it("defaults the threshold to 300000", () => {
    const sup = new AutoCompactSupervisor();
    expect(
      sup.onHandoff({ inputTokenCount: 300000, stopReason: "end_turn" }),
    ).toEqual({ type: "compact" });
    expect(
      sup.onHandoff({ inputTokenCount: 299999, stopReason: "end_turn" }),
    ).toEqual({ type: "none" });
  });

  it("passes through the configured nextPrompt", () => {
    const sup = new AutoCompactSupervisor({
      threshold: 100,
      nextPrompt: "custom",
    });
    expect(
      sup.onHandoff({ inputTokenCount: 200, stopReason: "end_turn" }),
    ).toEqual({ type: "compact", nextPrompt: "custom" });
  });
});
