import { describe, expect, it, vi } from "vitest";
import type {
  GitClient,
  GitCommandRunner,
  GitState,
} from "../capabilities/git-client.ts";
import { parseGitState } from "../capabilities/git-client.ts";
import type { Logger } from "../logger.ts";
import type { NativeMessageIdx } from "../providers/provider-types.ts";
import {
  type GitContextUpdate,
  GitSupervisor,
  GitTracker,
  gitUpdateToText,
} from "./git-supervisor.ts";

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
  const onSent = vi.fn<(u: GitContextUpdate) => void>();
  return {
    supervisor: GitSupervisor.create({
      gitClient,
      initialGitState: initial,
      logger: noopLogger,
      onSent,
    }),
    onSent,
  };
}

describe("GitSupervisor", () => {
  it("injects the git update text once on a branch change", async () => {
    const { supervisor, onSent } = setup(state("feature"), state("main"));

    const action = await supervisor.onBeforeRequest({
      inputTokenCount: 0,
      outputTokenCount: 0,
      nativeMessageIdx: 0 as NativeMessageIdx,
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
          inputTokenCount: 0,
          outputTokenCount: 0,
          nativeMessageIdx: 0 as NativeMessageIdx,
        })
      ).type,
    ).toBe("none");
    expect(onSent).toHaveBeenCalledTimes(1);
  });

  it("yields nothing when git state is unchanged", async () => {
    const { supervisor, onSent } = setup(state("main"), state("main"));
    expect(
      (
        await supervisor.onBeforeRequest({
          inputTokenCount: 0,
          outputTokenCount: 0,
          nativeMessageIdx: 0 as NativeMessageIdx,
        })
      ).type,
    ).toBe("none");
    expect(onSent).not.toHaveBeenCalled();
  });
});

function makeRunner(responses: {
  [command: string]: { stdout: string; exitCode: number };
}): GitCommandRunner {
  return (args) => {
    const key = args.join(" ");
    const match = responses[key];
    return Promise.resolve(match ?? { stdout: "", exitCode: 0 });
  };
}

describe("parseGitState", () => {
  it("returns undefined when not in a repo", async () => {
    const runner = makeRunner({
      "rev-parse --show-toplevel": { stdout: "", exitCode: 128 },
    });
    expect(await parseGitState(runner)).toBeUndefined();
  });

  it("parses branch, head, and porcelain counts", async () => {
    const runner = makeRunner({
      "rev-parse --show-toplevel": { stdout: "/repo\n", exitCode: 0 },
      "symbolic-ref --short -q HEAD": { stdout: "main\n", exitCode: 0 },
      "log -1 --format=%H%x00%s": {
        stdout: "abc123def456\u0000Initial commit\n",
        exitCode: 0,
      },
      "status --porcelain": {
        stdout: "M  staged.ts\n M unstaged.ts\nMM both.ts\n?? new.ts\n",
        exitCode: 0,
      },
    });
    const state = await parseGitState(runner);
    expect(state).toEqual<GitState>({
      repoRoot: "/repo",
      branch: "main",
      headSha: "abc123def456",
      headSubject: "Initial commit",
      stagedCount: 2,
      unstagedCount: 2,
      untrackedCount: 1,
    });
  });

  it("treats detached HEAD as undefined branch", async () => {
    const runner = makeRunner({
      "rev-parse --show-toplevel": { stdout: "/repo\n", exitCode: 0 },
      "symbolic-ref --short -q HEAD": { stdout: "", exitCode: 1 },
      "log -1 --format=%H%x00%s": { stdout: "sha\u0000subj\n", exitCode: 0 },
      "status --porcelain": { stdout: "", exitCode: 0 },
    });
    const state = await parseGitState(runner);
    expect(state?.branch).toBeUndefined();
  });
});

function clientFor(states: (GitState | undefined)[]): GitClient {
  let i = 0;
  return {
    getState: () => Promise.resolve(states[Math.min(i++, states.length - 1)]),
  };
}

const base: GitState = {
  repoRoot: "/repo",
  branch: "main",
  headSha: "sha1",
  headSubject: "first",
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
};

function trackerFor(
  states: (GitState | undefined)[],
  initialState: GitState | undefined = base,
): GitTracker {
  return GitTracker.create({
    gitClient: clientFor(states),
    initialState,
    logger: noopLogger,
  });
}

describe("GitTracker", () => {
  it("does not report when only file counts change", async () => {
    const tracker = trackerFor([{ ...base, untrackedCount: 5 }]);
    expect(await tracker.getUpdate(1 as NativeMessageIdx)).toBeUndefined();
  });

  it("reports when the branch changes", async () => {
    const tracker = trackerFor([{ ...base, branch: "feature" }]);
    const update = await tracker.getUpdate(1 as NativeMessageIdx);
    expect(update?.current?.branch).toBe("feature");
    expect(update?.previous?.branch).toBe("main");
  });

  it("reports when HEAD moves", async () => {
    const tracker = trackerFor([
      { ...base, headSha: "sha2", headSubject: "second" },
    ]);
    expect(await tracker.getUpdate(1 as NativeMessageIdx)).toBeDefined();
  });

  it("reports leaving a repository", async () => {
    const tracker = trackerFor([undefined]);
    const update = await tracker.getUpdate(1 as NativeMessageIdx);
    expect(update?.current).toBeUndefined();
    expect(gitUpdateToText(update!)).toContain(
      "no longer inside a git repository",
    );
  });

  it("peeks a pending update without committing the agent view", async () => {
    const changed = { ...base, branch: "feature" };
    const tracker = trackerFor([changed]);
    expect(await tracker.hasUpdate()).toBe(true);
    expect(await tracker.hasUpdate()).toBe(true);
    expect(
      (await tracker.getUpdate(1 as NativeMessageIdx))?.current?.branch,
    ).toBe("feature");
  });

  it("peeks false when nothing worth reporting changed", async () => {
    const tracker = trackerFor([{ ...base, untrackedCount: 5 }]);
    expect(await tracker.hasUpdate()).toBe(false);
  });

  it("peeks false when reading git state throws", async () => {
    const tracker = GitTracker.create({
      gitClient: {
        getState: () => Promise.reject(new Error("git is down")),
      },
      initialState: base,
      logger: noopLogger,
    });
    expect(await tracker.hasUpdate()).toBe(false);
  });

  it("commits the agent view so a change is reported only once", async () => {
    const changed = { ...base, branch: "feature" };
    const tracker = trackerFor([changed]);
    expect(await tracker.getUpdate(1 as NativeMessageIdx)).toBeDefined();
    expect(await tracker.getUpdate(2 as NativeMessageIdx)).toBeUndefined();
  });

  it("a clone before a delivered update reports it again", async () => {
    const changed = { ...base, branch: "feature" };
    const tracker = trackerFor([changed]);
    await tracker.getUpdate(3 as NativeMessageIdx);
    const clone = GitTracker.clone({
      source: tracker,
      nativeMessageIdx: 2 as NativeMessageIdx,
    });
    expect(
      (await clone.getUpdate(4 as NativeMessageIdx))?.current?.branch,
    ).toBe("feature");
  });

  it("a clone through a delivered update does not report it again", async () => {
    const changed = { ...base, branch: "feature" };
    const tracker = trackerFor([changed]);
    await tracker.getUpdate(3 as NativeMessageIdx);
    const clone = GitTracker.clone({
      source: tracker,
      nativeMessageIdx: 3 as NativeMessageIdx,
    });
    expect(await clone.getUpdate(4 as NativeMessageIdx)).toBeUndefined();
  });
});
