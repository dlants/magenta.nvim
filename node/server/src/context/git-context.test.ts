import { expect, it } from "vitest";
import type { GitState } from "../capabilities/git-client.ts";
import { withHarness } from "../test/harness.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";

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
const other: GitState = { ...git, repoRoot: "/other", branch: "other-main" };
const untouched: GitState = { ...git, repoRoot: "/untouched", branch: "u" };
it("starts tracking a repo when the agent reads a file in it", () =>
  withHarness(
    { git: [git, other, untouched], files: { "/other/x.txt": "hi\n" } },
    async (h) => {
      const { thread } = await h.createRoot();
      const first = h.send(thread, "read it");
      (await h.nextStream()).respond({
        stopReason: "tool_use",
        text: "reading",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "read_other" as ToolRequestId,
              toolName: "get_files" as ToolName,
              input: { files: [{ filePath: "/other/x.txt" }] },
            },
          },
        ],
      });
      const afterRead = await h.nextStream();
      const afterReadText = JSON.stringify(afterRead.messages);
      expect(afterReadText).toContain("Now tracking this git repository");
      expect(afterReadText).toContain("Branch: other-main");
      afterRead.respond({
        stopReason: "end_turn",
        text: "ok",
        toolRequests: [],
      });
      await first;

      h.git.set({ ...other, headSha: "fedcba9876543", headSubject: "moved" });
      h.git.set({ ...untouched, branch: "changed" });
      void h.send(thread, "again");
      const text = JSON.stringify((await h.nextStream()).messages.at(-1));
      expect(text).toContain("HEAD: fedcba9 moved");
      expect(text).not.toContain("/untouched");
    },
  ));
it("sends no git context when started outside any repo", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "hello");
    const text = JSON.stringify((await h.nextStream()).messages);
    expect(text).toContain("not a git repository");
    expect(text).not.toContain("# Git status update");
  }));
