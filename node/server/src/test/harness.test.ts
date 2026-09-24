import { expect, it } from "vitest";
import { TitleSupervisor } from "../thread-assembly.ts";
import {
  MaxTokensSupervisor,
  SubagentSupervisor,
} from "../thread-supervisor.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { pollUntil } from "../utils/async.ts";
import { FakeShell, shellResult } from "./fakes.ts";
import { withHarness } from "./harness.ts";

const git = {
  repoRoot: "/project",
  branch: "feature-x",
  headSha: "abc123",
  headSubject: "init",
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
};

it("sends a message and records the response", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    const done = h.send(thread, "hello");
    const stream = await h.nextStream();
    stream.streamText("hi there");
    stream.finishResponse("end_turn");
    await expect(done).resolves.toMatchObject({ type: "completed" });
    const messages = thread.getProviderMessages();
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [expect.objectContaining({ type: "text", text: "hi there" })],
    });
  }));

it("forks a thread with its history", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    const done = h.send(thread, "hello");
    const stream = await h.nextStream();
    stream.streamText("answer");
    stream.finishResponse("end_turn");
    await done;
    const fork = h.thread(await h.session.forkThread(id));
    expect(fork.getProviderMessages().slice(0, -1)).toEqual(
      thread.getProviderMessages(),
    );
  }));

it("spawns a subagent through the session", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    void h.send(thread, "delegate");
    const stream = await h.nextStream();
    stream.streamToolUse(
      "spawn-1" as ToolRequestId,
      "spawn_subagents" as ToolName,
      { agents: [{ prompt: "child work" }] },
    );
    stream.finishResponse("tool_use");
    const child = await pollUntil(() => {
      const record = h.session
        .listThreads()
        .find((r) => r.parentThreadId === id && r.state === "initialized");
      if (!record) throw new Error("waiting for child");
      return record;
    });
    // Parity with the nvim host (chat/supervisor-wiring.test.ts).
    expect(
      h.thread(child.id).turnSupervisors.map((s) => s.constructor),
    ).toEqual([MaxTokensSupervisor, SubagentSupervisor, TitleSupervisor]);
  }));

it("root supervisor order matches the nvim host", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    expect(thread.turnSupervisors.map((s) => s.constructor)).toEqual([
      MaxTokensSupervisor,
      TitleSupervisor,
    ]);
    expect(thread.tokenBudget).toBeDefined();
  }));

it("resolves @file: against the in-memory fs into context", () =>
  withHarness(
    { files: { "/project/src/a.ts": "const a = 1;\n" } },
    async (h) => {
      const { thread } = await h.createRoot();
      void h.send(thread, "look at @file:src/a.ts");
      await h.nextStream();
      expect(Object.keys(thread.contextFiles.files)).toEqual([
        "/project/src/a.ts",
      ]);
      expect(JSON.stringify(thread.getProviderMessages())).toContain(
        "const a = 1;",
      );
    },
  ));

it("puts git state in the first message's system info", () =>
  withHarness({ git }, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "hi");
    await h.nextStream();
    expect(JSON.stringify(thread.getProviderMessages()[0])).toContain(
      "feature-x",
    );
  }));

it("disposal leaves no threads behind", async () => {
  await withHarness({}, async (h) => {
    await h.createRoot();
    const pending = h.session.createRootThread();
    await h.dispose();
    await expect(pending).rejects.toThrow();
    expect(h.session.listThreads()).toEqual([]);
  });
});

function runBash(
  h: Parameters<Parameters<typeof withHarness>[1]>[0],
  command: string,
) {
  return (async () => {
    const { thread } = await h.createRoot();
    const done = h.send(thread, "run it");
    const stream = await h.nextStream();
    stream.streamToolUse(
      "bash-1" as ToolRequestId,
      "bash_command" as ToolName,
      {
        command,
      },
    );
    stream.finishResponse("tool_use");
    return { thread, done };
  })();
}
async function finish(
  h: Parameters<Parameters<typeof withHarness>[1]>[0],
  done: Promise<unknown>,
) {
  const next = await h.nextStream();
  next.finishResponse("end_turn");
  await done;
}
it("runs a scripted shell command", () =>
  withHarness({ shell: { "echo hi": { stdout: "hi-out" } } }, async (h) => {
    const { thread, done } = await runBash(h, "echo hi");
    await finish(h, done);
    expect(h.shell.calls).toEqual(["echo hi"]);
    expect(h.shell.pending).toEqual([]);
    expect(JSON.stringify(thread.getProviderMessages())).toContain("hi-out");
  }));
it("leaves unscripted shell commands pending until settled", () =>
  withHarness({}, async (h) => {
    const { thread, done } = await runBash(h, "echo slow");
    const call = await pollUntil(() => {
      const entry = h.shell.pending[0];
      if (!entry) throw new Error("waiting for shell");
      return entry;
    });
    expect(call.command).toBe("echo slow");
    call.result.resolve(shellResult({ stdout: "slow-out" }));
    await finish(h, done);
    expect(JSON.stringify(thread.getProviderMessages())).toContain("slow-out");
  }));
it("terminate settles pending shell commands with SIGTERM", async () => {
  const shell = new FakeShell();
  const result = shell.execute("sleep 10", {});
  shell.terminate();
  await expect(result).resolves.toMatchObject({
    exitCode: 143,
    signal: "SIGTERM",
  });
  expect(shell.pending).toEqual([]);
});
it("forks keep the source's system info rather than re-reading git", () =>
  withHarness({ git }, async (h) => {
    const { id, thread } = await h.createRoot();
    const done = h.send(thread, "hello");
    const stream = await h.nextStream();
    stream.finishResponse("end_turn");
    await done;
    h.git.set({ ...git, branch: "other-branch" });
    const fork = h.thread(await h.session.forkThread(id));
    const first = JSON.stringify(fork.getProviderMessages()[0]);
    expect(first).toContain("feature-x");
    expect(first).not.toContain("other-branch");
  }));
it("seeds autoContext files from the in-memory fs", () =>
  withHarness(
    {
      files: { "/project/context.md": "project notes" },
      options: { autoContext: ["context.md"] },
    },
    async (h) => {
      const { thread } = await h.createRoot();
      expect(Object.keys(thread.contextFiles.files)).toEqual([
        "/project/context.md",
      ]);
    },
  ));
