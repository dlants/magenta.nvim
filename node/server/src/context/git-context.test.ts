import { expect, it } from "vitest";
import type { GitState } from "../capabilities/git-client.ts";
import { withHarness } from "../test/harness.ts";

const git: GitState = {
  repoRoot: "/project",
  branch: "main",
  headSha: "abcdef1234567",
  headSubject: "initial commit",
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
};

it("reports initial git state in the first user message", () =>
  withHarness({ git }, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "hello");
    const text = JSON.stringify((await h.nextStream()).messages);
    expect(text).toContain("Git branch: main");
    expect(text).toContain("Git HEAD: abcdef1 initial commit");
  }));

it("attaches a git context update when the branch changes", () =>
  withHarness({ git }, async (h) => {
    const { thread } = await h.createRoot();
    const first = h.send(thread, "first");
    (await h.nextStream()).respond({
      stopReason: "end_turn",
      text: "ok",
      toolRequests: [],
    });
    await first;
    h.git.set({ ...git, branch: "feature" });
    void h.send(thread, "second");
    const text = JSON.stringify((await h.nextStream()).messages);
    expect(text).toContain("# Git status update");
    expect(text).toContain("Branch: feature");
  }));

it("sends no git update when state is unchanged", () =>
  withHarness({ git }, async (h) => {
    const { thread } = await h.createRoot();
    const first = h.send(thread, "first");
    (await h.nextStream()).respond({
      stopReason: "end_turn",
      text: "ok",
      toolRequests: [],
    });
    await first;
    void h.send(thread, "second");
    const text = JSON.stringify((await h.nextStream()).messages);
    expect(text).not.toContain("# Git status update");
  }));
