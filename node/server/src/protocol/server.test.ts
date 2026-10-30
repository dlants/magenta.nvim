import { expect, it } from "vitest";
import type { ApprovalId } from "../capabilities/sandbox-violation-handler.ts";
import type { ThreadId } from "../chat-types.ts";
import type { MockStream } from "../providers/mock-anthropic-client.ts";
import type { SessionId, SessionThread } from "../session.ts";
import { shellResult } from "../test/fakes.ts";
import { withHarness } from "../test/harness.ts";
import { ABORTED } from "../thread-api.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { pollUntil } from "../utils/async.ts";
import { createInProcessServer } from "./server.ts";
import type { ProtocolSessionState, ProtocolThreadState } from "./state.ts";
import { threadState } from "./state.ts";

const text = (t: string) => ({
  type: "resolved" as const,
  messages: [{ type: "text" as const, text: t }],
});

function respondBash(stream: MockStream, id: string) {
  stream.respond({
    stopReason: "tool_use",
    text: "working",
    toolRequests: [
      {
        status: "ok",
        value: {
          id: id as ToolRequestId,
          toolName: "bash_command" as ToolName,
          input: { description: "test", command: "slow" },
        },
      },
    ],
  });
}

it("delivers thread state in order and the last delivery is current", () =>
  withHarness({}, async (h) => {
    const server = createInProcessServer({ session: h.session });
    const { id, thread } = await h.createRoot();
    const seen: (ProtocolThreadState | undefined)[] = [];
    server.subscribe({ type: "thread", threadId: id }, (s) => seen.push(s));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.run.type).toBe("idle");

    const result = server.execute({
      type: "thread.submit",
      threadId: id,
      input: text("hi"),
    });
    const stream = await h.nextStream();
    stream.streamText("hel");
    await pollUntil(() => {
      const run = seen.at(-1)?.run;
      if (run?.type !== "running" || run.activity.type !== "streaming")
        throw new Error("waiting for streaming");
    });
    stream.respond({ stopReason: "end_turn", text: "hello", toolRequests: [] });
    expect(await result).toEqual({
      type: "submitted",
      submission: { type: "completed", stopReason: "end_turn" },
    });
    await Promise.resolve();
    await Promise.resolve();

    const types = seen.map((s) => s?.run.type);
    expect(types[0]).toBe("idle");
    expect(types).toContain("running");
    expect(types.at(-1)).toBe("idle");
    const record = h.session.getThread(id);
    if (record?.state !== "initialized") throw new Error("not ready");
    expect(seen.at(-1)).toEqual(
      threadState(thread, record.compactor, h.session),
    );
    await server.dispose();
  }));

it("coalesces synchronous updates", () =>
  withHarness({}, async (h) => {
    const server = createInProcessServer({ session: h.session });
    const { id } = await h.createRoot();
    let deliveries = 0;
    let last: ProtocolThreadState | undefined;
    server.subscribe({ type: "thread", threadId: id }, (s) => {
      deliveries++;
      last = s;
    });
    const ops = [];
    for (let i = 0; i < 50; i++) {
      ops.push(
        server.execute({
          type: "thread.setTitle",
          threadId: id,
          title: `t${i}`,
        }),
      );
    }
    expect(deliveries).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.all(ops);
    expect(deliveries).toBe(2);
    expect(last?.title).toBe("t49");
  }));

it("delivers undefined once on deletion; unsubscribing does not affect runs", () =>
  withHarness({}, async (h) => {
    const server = createInProcessServer({ session: h.session });
    const a = await h.createRoot();
    const b = await h.createRoot();
    const seen: (ProtocolThreadState | undefined)[] = [];
    server.subscribe({ type: "thread", threadId: a.id }, (s) => seen.push(s));

    const unsubscribe = server.subscribe(
      { type: "thread", threadId: b.id },
      () => {},
    );
    const run = server.execute({
      type: "thread.submit",
      threadId: b.id,
      input: text("hi"),
    });
    const stream = await h.nextStream();
    unsubscribe();
    stream.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
    expect(await run).toMatchObject({ submission: { type: "completed" } });

    expect(
      await server.execute({ type: "thread.delete", threadId: a.id }),
    ).toEqual({ type: "ok" });
    await pollUntil(() => {
      if (seen.at(-1) !== undefined) throw new Error("waiting");
    });
    const count = seen.length;
    h.session.emit("changed", a.id);
    await Promise.resolve();
    expect(seen.length).toBe(count);
    expect(seen.filter((s) => s === undefined)).toHaveLength(1);
  }));

it("aborts one running tool by id", () =>
  withHarness({}, async (h) => {
    const server = createInProcessServer({ session: h.session });
    const { id } = await h.createRoot();
    const done = server.execute({
      type: "thread.submit",
      threadId: id,
      input: text("run"),
    });
    respondBash(await h.nextStream(), "bash1");
    await pollUntil(() => {
      if (!h.shell.pending.length) throw new Error("waiting for shell");
    });
    expect(
      await server.execute({
        type: "tool.abort",
        threadId: id,
        toolRequestId: "bash1" as ToolRequestId,
      }),
    ).toEqual({ type: "ok" });
    (await h.nextStream()).respond({
      stopReason: "end_turn",
      text: "ok",
      toolRequests: [],
    });
    expect(await done).toMatchObject({ submission: { type: "completed" } });
    const record = h.session.getThread(id);
    if (record?.state !== "initialized") throw new Error("not ready");
    expect(
      threadState(record.thread, record.compactor, h.session).tools[
        "bash1" as ToolRequestId
      ]?.status,
    ).toBe("done");
    expect(
      await server.execute({
        type: "tool.abort",
        threadId: id,
        toolRequestId: "bash1" as ToolRequestId,
      }),
    ).toMatchObject({ type: "error" });
  }));

it("approves a pending prompt by id and rejects unknown ids", () =>
  withHarness({}, async (h) => {
    const server = createInProcessServer({ session: h.session });
    const { id } = await h.createRoot();
    let state: ProtocolSessionState | undefined;
    server.subscribe(
      { type: "session", sessionId: h.session.id },
      (s) => (state = s),
    );
    const prompt = h.session
      .approvalsFor(id)
      .promptForApproval("rm x", async () => shellResult({ stdout: "ran" }));
    await Promise.resolve();
    const approval = state?.pendingApprovals[0];
    expect(approval?.prompt).toEqual({
      kind: "approval-prompt",
      command: "rm x",
    });
    expect(
      await server.execute({
        type: "approval.approve",
        threadId: id,
        approvalId: approval?.id as ApprovalId,
      }),
    ).toEqual({ type: "ok" });
    await expect(prompt).resolves.toMatchObject({ exitCode: 0 });
    await Promise.resolve();
    expect(state?.pendingApprovals).toEqual([]);

    const unknown = "nope" as ThreadId;
    for (const op of [
      { type: "thread.submit", threadId: unknown, input: text("x") },
      { type: "thread.delete", threadId: unknown },
      {
        type: "approval.approve",
        threadId: id,
        approvalId: "nope" as ApprovalId,
      },
      { type: "script.abort", invocationId: "nope" },
      { type: "session.setActiveProfile", sessionId: "s", name: "x" },
      { type: "thread.fork", threadId: unknown },
    ] as const) {
      expect(await server.execute(op as never)).toMatchObject({
        type: "error",
      });
    }
  }));

it("approval.approveAllInSubtree resolves approvals of child threads", () =>
  withHarness({}, async (h) => {
    const server = createInProcessServer({ session: h.session });
    const { id: root } = await h.createRoot();
    const child = await h.session.spawnThread({
      parentThreadId: root,
      prompt: "child work",
      threadType: "subagent",
    });
    if (child === ABORTED) throw new Error("aborted");
    const prompts = [root, child].map((threadId) =>
      h.session
        .approvalsFor(threadId)
        .promptForApproval("rm x", async () => shellResult({ stdout: "ran" })),
    );
    const topic = { type: "session", sessionId: h.session.id } as const;
    expect(server.getState(topic)?.pendingApprovals).toHaveLength(2);
    expect(
      await server.execute({
        type: "approval.approveAllInSubtree",
        threadId: root,
      }),
    ).toEqual({ type: "ok" });
    for (const prompt of prompts) {
      await expect(prompt).resolves.toMatchObject({ exitCode: 0 });
    }
    expect(server.getState(topic)?.pendingApprovals).toEqual([]);
  }));

it("session state reflects thread.create and setActiveProfile", () =>
  withHarness({}, async (h) => {
    const server = createInProcessServer({ session: h.session });
    const states: (ProtocolSessionState | undefined)[] = [];
    server.subscribe({ type: "session", sessionId: h.session.id }, (s) =>
      states.push(s),
    );
    expect(states[0]?.threads).toEqual([]);
    const created = await server.execute({
      type: "thread.create",
      sessionId: h.session.id,
    });
    expect(created).toMatchObject({
      type: "created",
      threadId: expect.any(String),
    });
    await Promise.resolve();
    expect(states.at(-1)?.threads.map((t) => t.id)).toEqual([
      created.type === "created" && created.threadId,
    ]);

    const profile = h.session.getProfileSelection();
    expect(
      await server.execute({
        type: "session.setActiveProfile",
        sessionId: h.session.id,
        name: h.host.getDefaultProfile().name,
      }),
    ).toEqual({ type: "ok" });
    await Promise.resolve();
    expect(states.at(-1)?.activeProfile).toEqual(
      h.session.getProfileSelection(),
    );
    expect(profile).toBeDefined();
    expect(
      await server.execute({
        type: "session.setActiveProfile",
        sessionId: h.session.id as SessionId,
        name: "missing",
      }),
    ).toEqual({ type: "error", message: 'Profile "missing" not found.' });
  }));
it("queues async/next submissions and delivers them at rest", () =>
  withHarness({}, async (h) => {
    const server = createInProcessServer({ session: h.session });
    const { id, thread } = await h.createRoot();
    const first = server.execute({
      type: "thread.submit",
      threadId: id,
      input: text("first"),
    });
    const stream = await h.nextStream();
    expect(
      await server.execute({
        type: "thread.submit",
        threadId: id,
        input: text("later"),
        delivery: "next",
      }),
    ).toEqual({ type: "queued" });
    stream.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
    (await h.nextStream()).respond({
      stopReason: "end_turn",
      text: "ok2",
      toolRequests: [],
    });
    await first;
    await pollUntil(() => {
      if (thread.state.type === "running") throw new Error("busy");
    });
    expect(JSON.stringify(thread.getProviderMessages())).toContain("later");
  }));
it("script operations without a script runner return errors", () =>
  withHarness({}, async (h) => {
    const server = createInProcessServer({ session: h.session });
    for (const op of [
      { type: "script.discover", sessionId: h.session.id },
      { type: "script.delete", invocationId: "nope" },
      {
        type: "script.run",
        sessionId: h.session.id,
        name: "x",
        parameters: {},
      },
    ] as const) {
      expect(await server.execute(op as never)).toMatchObject({
        type: "error",
      });
    }
  }));
it("thread.abort returns the rendered unsent queued input", () =>
  withHarness({}, async (h) => {
    const server = createInProcessServer({ session: h.session });
    const { id } = await h.createRoot();
    const first = server.execute({
      type: "thread.submit",
      threadId: id,
      input: text("first"),
    });
    await h.nextStream();
    await server.execute({
      type: "thread.submit",
      threadId: id,
      input: text("queued later"),
      delivery: "next",
    });
    const aborted = await server.execute({
      type: "thread.abort",
      threadId: id,
    });
    expect(aborted.type).toBe("threadAborted");
    if (aborted.type !== "threadAborted") throw new Error("unreachable");
    expect(aborted.unsent).toHaveLength(1);
    expect(aborted.unsent[0]).toContain("queued later");
    await first;

    expect(
      await server.execute({ type: "thread.abort", threadId: id }),
    ).toEqual({ type: "threadAborted", unsent: [] });
  }));
it("markAttended and user submissions record attention; agent updates do not", () =>
  withHarness({}, async (h) => {
    const server = createInProcessServer({ session: h.session });
    const { id } = await h.createRoot();
    const monitor = h.session.pullRequestMonitor;
    if (!monitor) throw new Error("expected a monitor");
    let wakes = 0;
    const original = monitor.noteAttention.bind(monitor);
    monitor.noteAttention = () => {
      wakes++;
      original();
    };
    const record = h.session.listThreads().find((r) => r.id === id) as
      | SessionThread
      | undefined;
    if (!record) throw new Error("missing record");
    record.lastAttentionTime = 0;
    expect(h.session.getLastAttention(id)).toBe(0);
    expect(
      await server.execute({ type: "thread.markAttended", threadId: id }),
    ).toEqual({ type: "ok" });
    expect(h.session.getLastAttention(id)).toBeGreaterThan(0);
    expect(wakes).toBe(1);

    record.lastAttentionTime = 0;
    const result = server.execute({
      type: "thread.submit",
      threadId: id,
      input: text("hi"),
    });
    const stream = await h.nextStream();
    expect(h.session.getLastAttention(id)).toBeGreaterThan(0);
    expect(wakes).toBe(2);
    record.lastAttentionTime = 0;
    // A running thread counts as attended now.
    expect(h.session.getLastAttention(id)).toBeGreaterThan(0);
    stream.respond({ stopReason: "end_turn", text: "hello", toolRequests: [] });
    await result;
    expect(record.lastAttentionTime).toBe(0);
    expect(h.session.getLastAttention(id)).toBe(0);
    const unknown = "unknown" as ThreadId;
    expect(h.session.getLastAttention(unknown)).toBeUndefined();
    h.session.markAttended(unknown);
    expect(wakes).toBe(2);
  }));
