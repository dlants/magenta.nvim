import { describe, expect, it, vi } from "vitest";
import type {
  GitClient,
  GitCommandRunner,
  GitState,
} from "../capabilities/git-client.ts";
import { parseGitState } from "../capabilities/git-client.ts";
import type { NativeMessageIdx } from "../providers/provider-types.ts";
import { FakeGitClient } from "../test/fakes.ts";
import { noopLogger } from "../test-helpers.ts";
import { Defer } from "../utils/async.ts";
import type { AbsFilePath } from "../utils/files.ts";
import {
  type GitContextUpdate,
  GitSupervisor,
  GitTracker,
  gitUpdateToText,
} from "./git-supervisor.ts";

function state(branch: string): GitState {
  return {
    repoRoot: "/repo" as AbsFilePath,
    branch,
    headSha: "abc123",
    headSubject: "Initial commit",
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
  };
}

function setup(current: GitState, initial: GitState | undefined) {
  const gitClient = new FakeGitClient(current);
  const onSent = vi.fn<(u: GitContextUpdate) => void>();
  const supervisor = GitSupervisor.create({
    gitClient,
    initialGitState: initial,
    logger: noopLogger,
  });
  supervisor.callbacks = { ...supervisor.callbacks, onSent: onSent };
  return { supervisor, onSent };
}

describe("GitSupervisor", () => {
  it("injects the git update text once on a branch change", async () => {
    const { supervisor, onSent } = setup(state("feature"), state("main"));

    const action = await supervisor.onBeforeRequest({
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
      repoRoot: "/repo" as AbsFilePath,
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
    findRepoRoot: () => Promise.resolve("/repo" as AbsFilePath),
    getState: () => Promise.resolve(states[Math.min(i++, states.length - 1)]),
  };
}

const base: GitState = {
  repoRoot: "/repo" as AbsFilePath,
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

  it("retains refreshed counts for a later coarse update and clone", async () => {
    const refreshed = { ...base, stagedCount: 2, untrackedCount: 5 };
    const changed = {
      ...refreshed,
      branch: "feature",
      headSha: "sha2",
      headSubject: "second",
    };
    const tracker = trackerFor([refreshed, changed]);

    expect(await tracker.getUpdate(1 as NativeMessageIdx)).toBeUndefined();

    const clone = GitTracker.clone({
      source: tracker,
      nativeMessageIdx: 1 as NativeMessageIdx,
    });
    expect(clone.getAgentView().get("/repo" as AbsFilePath)).toEqual(refreshed);

    const update = await tracker.getUpdate(2 as NativeMessageIdx);
    expect(update?.repos[0]).toEqual({
      type: "changed",
      repoRoot: "/repo",
      previous: refreshed,
      current: changed,
    });
  });

  it("reports when the branch changes", async () => {
    const tracker = trackerFor([{ ...base, branch: "feature" }]);
    const update = await tracker.getUpdate(1 as NativeMessageIdx);
    expect(update?.repos[0]).toMatchObject({
      type: "changed",
      previous: { branch: "main" },
      current: { branch: "feature" },
    });
  });

  it("reports when HEAD moves", async () => {
    const tracker = trackerFor([
      { ...base, headSha: "sha2", headSubject: "second" },
    ]);
    expect(await tracker.getUpdate(1 as NativeMessageIdx)).toBeDefined();
  });

  it("rejects a coarse change recorded before the latest history entry", async () => {
    const tracker = trackerFor([
      { ...base, branch: "feature" },
      { ...base, branch: "other" },
    ]);
    await tracker.getUpdate(5 as NativeMessageIdx);

    await expect(tracker.getUpdate(4 as NativeMessageIdx)).rejects.toThrow(
      "Git view history must be monotonic: 4 < 5",
    );
  });

  it("reports leaving a repository", async () => {
    const tracker = trackerFor([undefined]);
    const update = await tracker.getUpdate(1 as NativeMessageIdx);
    expect(update?.repos[0]?.type).toBe("gone");
    expect(gitUpdateToText(update!)).toContain("No longer a git repository");
  });

  it("peeks a pending update without committing the agent view", async () => {
    const changed = { ...base, branch: "feature" };
    const tracker = trackerFor([changed]);
    expect(await tracker.hasUpdate()).toBe(true);
    expect(await tracker.hasUpdate()).toBe(true);
    expect(
      (await tracker.getUpdate(1 as NativeMessageIdx))?.repos[0],
    ).toMatchObject({ current: { branch: "feature" } });
  });

  it("peeks false when nothing worth reporting changed", async () => {
    const tracker = trackerFor([{ ...base, untrackedCount: 5 }]);
    expect(await tracker.hasUpdate()).toBe(false);
  });

  it("peeks false when reading git state throws", async () => {
    const tracker = GitTracker.create({
      gitClient: {
        findRepoRoot: () => Promise.resolve("/repo" as AbsFilePath),
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
      (await clone.getUpdate(4 as NativeMessageIdx))?.repos[0],
    ).toMatchObject({ current: { branch: "feature" } });
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

describe("GitTracker multi-repo", () => {
  const other: GitState = {
    ...base,
    repoRoot: "/other" as AbsFilePath,
    branch: "o",
  };
  function twoRepos() {
    const client = new FakeGitClient([base, other]);
    const tracker = GitTracker.create({
      gitClient: client,
      initialState: base,
      logger: noopLogger,
    });
    return { client, tracker };
  }

  it("reports a newly registered repo in full, once", async () => {
    const { tracker } = twoRepos();
    await tracker.registerPath("/other/a.txt" as AbsFilePath);
    await tracker.registerPath("/other/b.txt" as AbsFilePath);
    const update = await tracker.getUpdate(1 as NativeMessageIdx);
    expect(update?.repos).toEqual([
      { type: "registered", repoRoot: "/other", current: other },
    ]);
    expect(await tracker.getUpdate(2 as NativeMessageIdx)).toBeUndefined();
  });

  it("registering a path in an already tracked repo reports nothing", async () => {
    const { tracker } = twoRepos();
    await tracker.registerPath("/repo/a.txt" as AbsFilePath);
    expect(await tracker.hasUpdate()).toBe(false);
    expect(await tracker.getUpdate(1 as NativeMessageIdx)).toBeUndefined();
  });

  it("an unawaited registration is included in the next update", async () => {
    const root = new Defer<AbsFilePath | undefined>();
    const client = new FakeGitClient([base, other]);
    vi.spyOn(client, "findRepoRoot").mockReturnValueOnce(root.promise);
    const tracker = GitTracker.create({
      gitClient: client,
      initialState: base,
      logger: noopLogger,
    });
    void tracker.registerPath("/other/a.txt" as AbsFilePath);
    const update = tracker.getUpdate(1 as NativeMessageIdx);
    root.resolve("/other" as AbsFilePath);
    expect((await update)?.repos).toEqual([
      { type: "registered", repoRoot: "/other", current: other },
    ]);
  });

  it("a failed repo lookup does not block later updates", async () => {
    const client = new FakeGitClient([{ ...base, branch: "feature" }]);
    vi.spyOn(client, "findRepoRoot").mockRejectedValueOnce(new Error("boom"));
    const tracker = GitTracker.create({
      gitClient: client,
      initialState: base,
      logger: noopLogger,
    });
    await tracker.registerPath("/x/a.txt" as AbsFilePath);
    expect(await tracker.hasUpdate()).toBe(true);
    expect(
      (await tracker.getUpdate(1 as NativeMessageIdx))?.repos[0],
    ).toMatchObject({ type: "changed", current: { branch: "feature" } });
  });

  it("ignores paths outside any repo", async () => {
    const { tracker } = twoRepos();
    await tracker.registerPath("/nowhere/a.txt" as AbsFilePath);
    expect(await tracker.hasUpdate()).toBe(false);
  });

  it("a fork before the registering delivery does not track the repo", async () => {
    const { client, tracker } = twoRepos();
    await tracker.registerPath("/other/a.txt" as AbsFilePath);
    await tracker.getUpdate(3 as NativeMessageIdx);
    const fork = GitTracker.clone({
      source: tracker,
      nativeMessageIdx: 2 as NativeMessageIdx,
    });
    expect([...fork.getAgentView().keys()]).toEqual(["/repo"]);
    client.set({ ...other, branch: "moved" });
    expect(await fork.getUpdate(4 as NativeMessageIdx)).toBeUndefined();
    const kept = GitTracker.clone({
      source: tracker,
      nativeMessageIdx: 3 as NativeMessageIdx,
    });
    expect(
      (await kept.getUpdate(4 as NativeMessageIdx))?.repos[0],
    ).toMatchObject({ current: { branch: "moved" } });
  });

  it("reports a tracked repo that disappears", async () => {
    const { client, tracker } = twoRepos();
    client.remove("/repo" as AbsFilePath);
    const update = await tracker.getUpdate(1 as NativeMessageIdx);
    expect(update?.repos[0]).toMatchObject({
      type: "gone",
      repoRoot: "/repo",
      previous: base,
    });
  });
});
