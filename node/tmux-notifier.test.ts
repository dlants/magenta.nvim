import { describe, it, expect } from "vitest";
import type { ThreadId } from "@magenta/core";
import {
  type ThreadSource,
  type TmuxInterface,
  TmuxNotifier,
} from "./tmux-notifier.ts";

function mockTmux(): TmuxInterface & { titles: string[] } {
  return {
    enabled: true,
    titles: [] as string[],
    async readTitle() {
      return "original-title";
    },
    setTitle(title: string) {
      this.titles.push(title);
    },
  };
}

function makeThreadSource(
  threads: Record<
    string,
    { type: "stopped"; reason: string } | { type: "running"; activity: string } | { type: "pending" }
  >,
): ThreadSource {
  return {
    threadIds: () => Object.keys(threads) as ThreadId[],
    getThreadSummary: (id) => ({
      status: threads[id as string],
    }),
  };
}

describe("TmuxNotifier", () => {
  it("should show approval count", () => {
    const tmux = mockTmux();
    const notifier = new TmuxNotifier(tmux);

    const source = makeThreadSource({
      t1: { type: "running", activity: "waiting for approval" },
      t2: { type: "running", activity: "waiting for approval" },
      t3: { type: "running", activity: "streaming response" },
    });

    notifier.update(source);
    expect(tmux.titles).toEqual(["🔴 2 approval · nvim"]);
  });

  it("should show 'nvim' when no notifications", () => {
    const tmux = mockTmux();
    const notifier = new TmuxNotifier(tmux);

    const source = makeThreadSource({
      t1: { type: "running", activity: "streaming response" },
      t2: { type: "pending" },
    });

    notifier.update(source);
    expect(tmux.titles).toEqual(["nvim"]);
  });

  it("should not count stopped threads while focused", () => {
    const tmux = mockTmux();
    const notifier = new TmuxNotifier(tmux);

    const source = makeThreadSource({
      t1: { type: "stopped", reason: "end_turn" },
    });

    notifier.update(source);
    expect(tmux.titles).toEqual(["nvim"]);
  });

  it("should count new stopped threads after focus lost", () => {
    const tmux = mockTmux();
    const notifier = new TmuxNotifier(tmux);

    const sourceBeforeLoss = makeThreadSource({
      t1: { type: "stopped", reason: "end_turn" },
    });

    // Lose focus with t1 already stopped
    notifier.onFocusLost(sourceBeforeLoss);

    // t2 stops while unfocused
    const sourceAfterNewStop = makeThreadSource({
      t1: { type: "stopped", reason: "end_turn" },
      t2: { type: "stopped", reason: "end_turn" },
    });

    notifier.update(sourceAfterNewStop);
    expect(tmux.titles).toEqual(["🔴 1 stopped · nvim"]);
  });

  it("should not count threads that were already stopped at focus loss", () => {
    const tmux = mockTmux();
    const notifier = new TmuxNotifier(tmux);

    const source = makeThreadSource({
      t1: { type: "stopped", reason: "end_turn" },
    });

    notifier.onFocusLost(source);
    notifier.update(source);
    expect(tmux.titles).toEqual(["nvim"]);
  });

  it("should clear stopped count on focus gained", () => {
    const tmux = mockTmux();
    const notifier = new TmuxNotifier(tmux);

    const emptySource = makeThreadSource({});
    notifier.onFocusLost(emptySource);

    const sourceWithStop = makeThreadSource({
      t1: { type: "stopped", reason: "end_turn" },
    });

    notifier.update(sourceWithStop);
    expect(tmux.titles).toEqual(["🔴 1 stopped · nvim"]);

    // Focus gained clears the count
    notifier.onFocusGained();
    tmux.titles = [];
    notifier.update(sourceWithStop);
    expect(tmux.titles).toEqual(["nvim"]);
  });

  it("should show both approval and stopped counts", () => {
    const tmux = mockTmux();
    const notifier = new TmuxNotifier(tmux);

    const emptySource = makeThreadSource({});
    notifier.onFocusLost(emptySource);

    const source = makeThreadSource({
      t1: { type: "running", activity: "waiting for approval" },
      t2: { type: "stopped", reason: "end_turn" },
    });

    notifier.update(source);
    expect(tmux.titles).toEqual(["🔴 1 approval · 1 stopped · nvim"]);
  });

  it("should not spawn process if title unchanged", () => {
    const tmux = mockTmux();
    const notifier = new TmuxNotifier(tmux);

    const source = makeThreadSource({
      t1: { type: "running", activity: "waiting for approval" },
    });

    notifier.update(source);
    notifier.update(source);
    notifier.update(source);

    // Only one call despite three updates
    expect(tmux.titles).toEqual(["🔴 1 approval · nvim"]);
  });

  it("should no-op when tmux is not available", () => {
    const tmux = mockTmux();
    tmux.enabled = false;
    const notifier = new TmuxNotifier(tmux);

    const source = makeThreadSource({
      t1: { type: "running", activity: "waiting for approval" },
    });

    notifier.update(source);
    expect(tmux.titles).toEqual([]);
  });

  it("should restore original title on cleanup", async () => {
    const tmux = mockTmux();
    const notifier = new TmuxNotifier(tmux);

    // Wait for readTitle promise to resolve
    await new Promise((r) => setTimeout(r, 0));

    const source = makeThreadSource({
      t1: { type: "running", activity: "waiting for approval" },
    });
    notifier.update(source);
    tmux.titles = [];

    notifier.cleanup();
    expect(tmux.titles).toEqual(["original-title"]);
  });
});
