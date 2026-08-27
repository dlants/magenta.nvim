import { describe, expect, it, vi } from "vitest";
import type { GitClient, GitState } from "../capabilities/git-client.ts";
import type { Logger } from "../logger.ts";
import { GitSupervisor } from "./git-supervisor.ts";
import type { GitContextUpdate } from "./git-tracker.ts";
import { GitTracker } from "./git-tracker.ts";

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
} as unknown as Logger;

function state(branch: string): GitState {
  return {
    repoRoot: "/repo",
    branch,
    headSha: "abc123",
    headSubject: "Initial commit",
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
  };
}

function setup(current: GitState, initial: GitState | undefined) {
  const gitClient: GitClient = {
    getState: () => Promise.resolve(current),
  } as unknown as GitClient;
  const tracker = new GitTracker(gitClient, initial, noopLogger);
  const onSent = vi.fn<(u: GitContextUpdate) => void>();
  return {
    supervisor: new GitSupervisor({ gitTracker: tracker, onSent }),
    onSent,
  };
}

describe("GitSupervisor", () => {
  it("injects the git update text once on a branch change", async () => {
    const { supervisor, onSent } = setup(state("feature"), state("main"));

    const action = await supervisor.onBeforeRequest({
      kind: "submission",
      inputTokenCount: 0,
    });
    expect(action.type).toBe("inject");
    if (action.type !== "inject") throw new Error("expected inject");
    expect(action.content).toHaveLength(1);
    const block = action.content[0];
    if (block.type !== "text") throw new Error("expected text");
    expect(block.text).toContain("# Git status update");
    expect(block.text).toContain("feature");
    expect(onSent).toHaveBeenCalledTimes(1);

    expect(
      (
        await supervisor.onBeforeRequest({
          kind: "submission",
          inputTokenCount: 0,
        })
      ).type,
    ).toBe("none");
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it("stays silent on a stop that issues no request", async () => {
    const { supervisor, onSent } = setup(state("feature"), state("main"));

    const action = await supervisor.onBeforeRequest({
      kind: "turn-end",
      stopReason: "end_turn",
      inputTokenCount: 0,
    });
    expect(action).toEqual({ type: "none" });
    expect(onSent).not.toHaveBeenCalled();

    // The agent view was not committed, so the change still rides the next
    // request.
    const next = await supervisor.onBeforeRequest({
      kind: "submission",
      inputTokenCount: 0,
    });
    expect(next.type).toBe("inject");
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it("yields nothing when git state is unchanged", async () => {
    const { supervisor, onSent } = setup(state("main"), state("main"));
    expect(
      (
        await supervisor.onBeforeRequest({
          kind: "submission",
          inputTokenCount: 0,
        })
      ).type,
    ).toBe("none");
    expect(onSent).not.toHaveBeenCalled();
  });
});
