import { describe, expect, it } from "vitest";
import type {
  GitClient,
  GitCommandRunner,
  GitState,
} from "../capabilities/git-client.ts";
import { parseGitState } from "../capabilities/git-client.ts";
import type { Logger } from "../logger.ts";
import { GitTracker, gitUpdateToText } from "./git-tracker.ts";

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
} as unknown as Logger;

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

describe("GitTracker", () => {
  it("does not report when only file counts change", async () => {
    const tracker = new GitTracker(
      clientFor([{ ...base, untrackedCount: 5 }]),
      base,
      noopLogger,
    );
    expect(await tracker.getUpdate()).toBeUndefined();
  });

  it("reports when the branch changes", async () => {
    const tracker = new GitTracker(
      clientFor([{ ...base, branch: "feature" }]),
      base,
      noopLogger,
    );
    const update = await tracker.getUpdate();
    expect(update?.current?.branch).toBe("feature");
    expect(update?.previous?.branch).toBe("main");
  });

  it("reports when HEAD moves", async () => {
    const tracker = new GitTracker(
      clientFor([{ ...base, headSha: "sha2", headSubject: "second" }]),
      base,
      noopLogger,
    );
    expect(await tracker.getUpdate()).toBeDefined();
  });

  it("reports leaving a repository", async () => {
    const tracker = new GitTracker(clientFor([undefined]), base, noopLogger);
    const update = await tracker.getUpdate();
    expect(update?.current).toBeUndefined();
    expect(gitUpdateToText(update!)).toContain(
      "no longer inside a git repository",
    );
  });

  it("peeks a pending update without committing the agent view", async () => {
    const changed = { ...base, branch: "feature" };
    const tracker = new GitTracker(clientFor([changed]), base, noopLogger);
    expect(await tracker.hasUpdate()).toBe(true);
    expect(await tracker.hasUpdate()).toBe(true);
    expect((await tracker.getUpdate())?.current?.branch).toBe("feature");
  });
  it("peeks false when nothing worth reporting changed", async () => {
    const tracker = new GitTracker(
      clientFor([{ ...base, untrackedCount: 5 }]),
      base,
      noopLogger,
    );
    expect(await tracker.hasUpdate()).toBe(false);
  });
  it("peeks false when reading git state throws", async () => {
    const tracker = new GitTracker(
      { getState: () => Promise.reject(new Error("git is down")) },
      base,
      noopLogger,
    );
    expect(await tracker.hasUpdate()).toBe(false);
  });
  it("commits the agent view so a change is reported only once", async () => {
    const changed = { ...base, branch: "feature" };
    const tracker = new GitTracker(clientFor([changed]), base, noopLogger);
    expect(await tracker.getUpdate()).toBeDefined();
    expect(await tracker.getUpdate()).toBeUndefined();
  });
});
