import { describe, expect, it } from "vitest";
import {
  AutoCompactSupervisor,
  mergeRequestActions,
} from "./thread-supervisor.ts";

describe("mergeRequestActions", () => {
  it("keeps a compact request when another supervisor injects", () => {
    expect(
      mergeRequestActions([
        { type: "inject", text: "note", andThen: { type: "none" } },
        { type: "compact", nextPrompt: "go" },
      ]),
    ).toEqual({
      type: "inject",
      text: "note",
      andThen: { type: "compact", nextPrompt: "go" },
    });
  });

  it("joins injected texts in order", () => {
    expect(
      mergeRequestActions([
        { type: "inject", text: "first", andThen: { type: "none" } },
        { type: "none" },
        { type: "inject", text: "second", andThen: { type: "none" } },
      ]),
    ).toEqual({
      type: "inject",
      text: "first\n\nsecond",
      andThen: { type: "none" },
    });
  });

  it("joins compact prompts and returns none when nothing was requested", () => {
    expect(
      mergeRequestActions([
        { type: "compact", nextPrompt: "a" },
        { type: "compact", nextPrompt: undefined },
        { type: "compact", nextPrompt: "b" },
      ]),
    ).toEqual({ type: "compact", nextPrompt: "a\n\nb" });
    expect(mergeRequestActions([{ type: "none" }])).toEqual({ type: "none" });
  });
});

describe("AutoCompactSupervisor", () => {
  it("returns compact (with nextPrompt) at or over the threshold", () => {
    const sup = new AutoCompactSupervisor({
      threshold: 300000,
      nextPrompt: "go",
    });
    expect(
      sup.onBeforeRequest({ inputTokenCount: 300000, stopReason: "end_turn" }),
    ).toEqual({ type: "compact", nextPrompt: "go" });
    expect(
      sup.onBeforeRequest({ inputTokenCount: 400000, stopReason: "end_turn" }),
    ).toEqual({ type: "compact", nextPrompt: "go" });
  });

  it("returns none below the threshold", () => {
    const sup = new AutoCompactSupervisor({
      threshold: 300000,
      nextPrompt: "go",
    });
    expect(
      sup.onBeforeRequest({ inputTokenCount: 299999, stopReason: "end_turn" }),
    ).toEqual({ type: "none" });
  });

  it("returns none when inputTokenCount is undefined", () => {
    const sup = new AutoCompactSupervisor({
      threshold: 300000,
      nextPrompt: "go",
    });
    expect(
      sup.onBeforeRequest({
        inputTokenCount: undefined,
        stopReason: "end_turn",
      }),
    ).toEqual({ type: "none" });
  });

  it("defaults the threshold to 300000", () => {
    const sup = new AutoCompactSupervisor({ nextPrompt: "go" });
    expect(
      sup.onBeforeRequest({ inputTokenCount: 300000, stopReason: "end_turn" }),
    ).toEqual({ type: "compact", nextPrompt: "go" });
    expect(
      sup.onBeforeRequest({ inputTokenCount: 299999, stopReason: "end_turn" }),
    ).toEqual({ type: "none" });
  });

  it("passes through the configured nextPrompt", () => {
    const sup = new AutoCompactSupervisor({
      threshold: 100,
      nextPrompt: "custom",
    });
    expect(
      sup.onBeforeRequest({ inputTokenCount: 200, stopReason: "end_turn" }),
    ).toEqual({ type: "compact", nextPrompt: "custom" });
  });
});
