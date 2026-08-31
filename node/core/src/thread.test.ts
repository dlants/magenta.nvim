import { describe, expect, it } from "vitest";
import type { AgentContext } from "./agent.ts";
import { phaseLabel } from "./agent.ts";
import type { ThreadType } from "./chat-types.ts";
import { type Compactor, runSubmission } from "./compaction/index.ts";
import {
  parseCompact,
  pendingMessage,
  renderPending,
} from "./submission/index.ts";
import {
  awaitNextStream,
  cleanupArchive,
  createAgentWithMock,
  uniqueThreadId,
  userTexts,
} from "./test-helpers.ts";
import type { Thread } from "./thread.ts";
import type { QueuedMessage } from "./thread-api.ts";
import {
  composeSupervisors,
  injectText,
  SystemInfoSupervisor,
} from "./thread-supervisor.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";
import { Defer, pollUntil } from "./utils/async.ts";

describe("deferred submissions", () => {
  it("resolves a queued message at delivery, not when it was queued", async () => {
    let fileContents = "before";
    const calls: string[] = [];
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("deferred-resolve"),
      (message) => {
        calls.push(fileContents);
        return Promise.resolve({
          compact: false,
          messages: [
            { type: "user" as const, text: `${message} [${fileContents}]` },
          ],
          reminders: [],
        });
      },
    );
    void core.send([{ type: "user", text: "start" }]);
    const stream = await mockClient.awaitStream();
    expect(
      await core.submit(pendingMessage("look at the file"), "next"),
    ).toEqual({ type: "queued" });
    // Nothing was resolved at queue time.
    expect(calls).toEqual([]);
    fileContents = "after";
    stream.streamText("working");
    stream.finishResponse("end_turn");
    const second = await awaitNextStream(mockClient, stream);
    expect(calls).toEqual(["after"]);
    expect(userTexts(core)).toContain("look at the file [after]");
    second.finishResponse("end_turn");
  });

  it("flushes the whole queue, in order, at one delivery point", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.send([{ type: "user", text: "start" }]);
    const stream = await mockClient.awaitStream();
    for (const text of ["one", "two", "three"]) {
      await core.submit(pendingMessage(text), "async");
    }
    expect(core.queued.async).toHaveLength(3);
    stream.streamText("working");
    stream.finishResponse("end_turn");
    const second = await awaitNextStream(mockClient, stream);
    expect(core.queued.async).toEqual([]);
    const texts = userTexts(core);
    expect(texts.slice(-3)).toEqual(["one", "two", "three"]);
    second.finishResponse("end_turn");
  });

  it("drops an entry whose resolution throws, and stays usable", async () => {
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("deferred-throw"),
      (message) =>
        message === "bad"
          ? Promise.reject(new Error("resolution failed"))
          : Promise.resolve({
              compact: false,
              messages: [{ type: "user" as const, text: message }],
              reminders: [],
            }),
    );
    void core.send([{ type: "user", text: "start" }]);
    const stream = await mockClient.awaitStream();
    await core.submit(pendingMessage("bad"), "next");
    await core.submit(pendingMessage("good"), "next");
    stream.streamText("working");
    stream.finishResponse("end_turn");
    const second = await awaitNextStream(mockClient, stream);
    const texts = userTexts(core);
    expect(texts).not.toContain("bad");
    expect(texts).toContain("good");
    second.finishResponse("end_turn");
    // The thread is not wedged: it still accepts and queues further work.
    await core.submit(pendingMessage("later"), "next");
  });

  it("sends a deferred submission immediately when the agent is idle", async () => {
    const { core, mockClient } = createAgentWithMock();
    // Nothing is in flight, so there is no delivery point to wait for.
    void core.submit(pendingMessage("do it now"), "next");
    const stream = await mockClient.awaitStream();
    expect(core.queued.next).toEqual([]);
    expect(userTexts(core)).toContain("do it now");
    stream.finishResponse("end_turn");
  });

  it("activates the reminders a queued entry resolves to", async () => {
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("deferred-reminder"),
      (message) =>
        Promise.resolve({
          compact: false,
          messages: [{ type: "user" as const, text: message }],
          reminders: ["remember the file"],
        }),
    );
    void core.send([{ type: "user", text: "start" }]);
    const stream = await mockClient.awaitStream();
    await core.submit(pendingMessage("queued"), "next");
    expect(core.activeReminders.has("remember the file")).toBe(false);
    stream.streamText("working");
    stream.finishResponse("end_turn");
    const second = await awaitNextStream(mockClient, stream);
    expect(core.activeReminders.has("remember the file")).toBe(true);
    second.finishResponse("end_turn");
  });

  it("still carries the standing reminder on the submission after a resting turn-end", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("working");
    // Enough output tokens to arm the standing reminder. Nothing is queued, so
    // this stop issues no request; the reminder must still reach the model on
    // the next user submission.
    stream.finishResponse("end_turn", { inputTokens: 1, outputTokens: 5000 });
    await pollUntil(() => {
      if (!core.isBusy) return true;
      throw new Error("waiting for the thread to come to rest");
    });
    void core.send([{ type: "user", text: "again" }]);
    const second = await awaitNextStream(mockClient, stream);
    const lastMessage = second.messages[second.messages.length - 1];
    expect(JSON.stringify(lastMessage.content)).toContain("<system-reminder>");
    second.finishResponse("end_turn");
  });
  it("comes to rest when every queued entry fails to resolve", async () => {
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("deferred-all-fail"),
      () => Promise.reject(new Error("resolution failed")),
    );
    const sent = core.send([{ type: "user", text: "start" }]);
    const stream = await mockClient.awaitStream();
    await core.submit(pendingMessage("bad"), "next");
    const streamsBefore = mockClient.streams.length;
    stream.finishResponse("end_turn");
    // The queue emptied into nothing, so there is no request to issue.
    expect(await sent).toEqual({ type: "completed", stopReason: "end_turn" });
    expect(mockClient.streams.length).toBe(streamsBefore);
    expect(core.queued.next).toEqual([]);
  });

  it("delivers a mid-turn queued message on the tool_use continuation", async () => {
    let resolveStat!: () => void;
    const statPromise = new Promise<{ mtimeMs: number; size: number }>(
      (resolve) => {
        resolveStat = () => resolve({ mtimeMs: 0, size: 100 });
      },
    );
    const { core, mockClient } = createAgentWithMock({
      fileIO: {
        readFile: async () => "file contents",
        writeFile: async () => {},
        fileExists: async () => true,
        stat: async () => statPromise,
      } as unknown as AgentContext["fileIO"],
    });
    void core.send([{ type: "user", text: "start" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "tool-midturn" as ToolRequestId,
      "get_files" as ToolName,
      { files: [{ filePath: "/tmp/test.txt" }] },
    );
    stream.finishResponse("tool_use");
    await pollUntil(() => {
      if (phaseLabel(core.phase) === "running_tools") return true;
      throw new Error(`waiting for tool_use, got ${phaseLabel(core.phase)}`);
    });
    expect(
      await core.submit(pendingMessage("also check this"), "async"),
    ).toEqual({ type: "queued" });
    resolveStat();

    const continuation = await awaitNextStream(mockClient, stream);
    // The text rides the continuation, coalesced into the same user message as
    // the tool result and ordered after it.
    const lastMessage = continuation.messages[continuation.messages.length - 1];
    expect(lastMessage.role).toBe("user");
    const blocks = lastMessage.content;
    if (typeof blocks === "string") throw new Error("expected content blocks");
    const toolResultIdx = blocks.findIndex((b) => b.type === "tool_result");
    expect(toolResultIdx).toBeGreaterThanOrEqual(0);
    expect(
      blocks.findIndex(
        (b) => b.type === "text" && b.text.includes("also check this"),
      ),
    ).toBeGreaterThan(toolResultIdx);
    expect(core.queued.async).toEqual([]);
    continuation.finishResponse("end_turn");
    // Exactly once: the stop behind the continuation finds both queues empty,
    // so `flushAtStop` has nothing left to re-deliver.
    await pollUntil(() => {
      if (!core.isBusy) return true;
      throw new Error("waiting for the thread to come to rest");
    });
    expect(mockClient.streams.length).toBe(2);
    expect(
      userTexts(core).filter((t) => t.includes("also check this")).length,
    ).toBe(1);
  });

  it("does not drain the async queue into an agent-internal submission", async () => {
    const { core, mockClient } = createAgentWithMock(
      { threadType: "subagent" as ThreadType },
      uniqueThreadId("deferred-yield-rejection"),
    );
    let rejected = false;
    core.hooks = composeSupervisors(() => [
      {
        onYield: async () => {
          if (rejected) return { type: "none" as const };
          rejected = true;
          return { type: "reject" as const, message: "not done yet" };
        },
      },
    ]);
    void core.send([{ type: "user", text: "do the task" }]);
    const stream = await mockClient.awaitStream();
    expect(
      await core.submit(pendingMessage("also check this"), "async"),
    ).toEqual({ type: "queued" });
    stream.streamToolUse(
      "tool-yield-rejected" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "done" },
    );
    stream.finishResponse("end_turn");
    // The rejection is a submission the agent makes on its own behalf. It is
    // an opening request like any other, so it does not pick up the queue,
    // which `flushAtStop` still owns.
    const rejection = await awaitNextStream(mockClient, stream);
    expect(userTexts(core)).toContain("not done yet");
    expect(userTexts(core)).not.toContain("also check this");
    expect(core.queued.async).toEqual([pendingMessage("also check this")]);
    rejection.finishResponse("end_turn");
    const flushed = await awaitNextStream(mockClient, rejection);
    expect(userTexts(core)).toContain("also check this");
    expect(core.queued.async).toEqual([]);
    flushed.finishResponse("end_turn");
  });
  it("defers an @async @compact past the request it cannot ride on", async () => {
    let resolveStat!: () => void;
    const statPromise = new Promise<{ mtimeMs: number; size: number }>(
      (resolve) => {
        resolveStat = () => resolve({ mtimeMs: 0, size: 100 });
      },
    );
    const { core, mockClient } = createAgentWithMock(
      {
        fileIO: {
          readFile: async () => "file contents",
          writeFile: async () => {},
          fileExists: async () => true,
          stat: async () => statPromise,
        } as unknown as AgentContext["fileIO"],
      },
      uniqueThreadId("deferred-async-compact"),
      (message) => {
        const { compact, rest } = parseCompact(message);
        return Promise.resolve({
          compact,
          messages: rest.length ? [{ type: "user" as const, text: rest }] : [],
          reminders: [],
        });
      },
    );
    const sent = core.send([{ type: "user", text: "start" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "tool-async-compact" as ToolRequestId,
      "get_files" as ToolName,
      { files: [{ filePath: "/tmp/test.txt" }] },
    );
    stream.finishResponse("tool_use");
    await pollUntil(() => {
      if (phaseLabel(core.phase) === "running_tools") return true;
      throw new Error(`waiting for tool_use, got ${phaseLabel(core.phase)}`);
    });
    expect(
      await core.submit(pendingMessage("@compact wrap it up"), "async"),
    ).toEqual({
      type: "queued",
    });
    resolveStat();

    // There is no place to hand the transcript over from mid-turn, so the
    // request carrying the tool results goes out without it.
    const toolResultStream = await awaitNextStream(mockClient, stream);
    expect(userTexts(core)).not.toContain("wrap it up");
    expect(core.queued.next).toEqual([pendingMessage("@compact wrap it up")]);

    // The next stop is the earliest point where it can take effect.
    toolResultStream.finishResponse("end_turn");
    expect(await sent).toEqual({
      type: "suspended",
      reason: { kind: "compact", nextPrompt: "wrap it up" },
    });
  });

  it("folds entries ahead of a stop-time @compact in, and re-queues the rest", async () => {
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("deferred-stop-compact"),
      (message) => {
        const { compact, rest } = parseCompact(message);
        return Promise.resolve({
          compact,
          messages: rest.length ? [{ type: "user" as const, text: rest }] : [],
          reminders: [],
        });
      },
    );
    const sent = core.send([{ type: "user", text: "start" }]);
    const stream = await mockClient.awaitStream();
    for (const text of ["first", "@compact wrap up", "third"]) {
      await core.submit(pendingMessage(text), "next");
    }
    stream.finishResponse("end_turn");

    // There is no request left to carry "first", so it folds into the prompt
    // the compaction hands to the next generation.
    expect(await sent).toEqual({
      type: "suspended",
      reason: { kind: "compact", nextPrompt: "first\nwrap up" },
    });
    // Everything behind the compaction keeps its place in the queue.
    expect(core.queued.next).toEqual([pendingMessage("third")]);
  });

  it("keeps a queue flushed for a stop-suspended request for the next request", async () => {
    const threadId = uniqueThreadId("deferred-stop-suspend");
    const { core, mockClient } = createAgentWithMock(undefined, threadId);
    try {
      let suspend = true;
      // Not the opening request of the send: the one the stop-time flush
      // produces.
      let requests = 0;
      core.hooks = composeSupervisors(() => [
        {
          onBeforeRequest: () =>
            Promise.resolve(
              suspend && ++requests > 1
                ? {
                    type: "suspend" as const,
                    reason: { kind: "stop" as const, message: "halt" },
                  }
                : { type: "none" as const },
            ),
        },
      ]);
      const first = core.send([{ type: "user", text: "start" }]);
      const stream = await mockClient.awaitStream();
      await core.submit(pendingMessage("queued"), "next");
      stream.finishResponse("end_turn");
      // The stop flushed the queue for a request the gate then refused. The
      // content is spent — it cannot be resolved again — so it is held for
      // whatever request this thread issues next.
      expect(await first).toEqual({
        type: "suspended",
        reason: { kind: "stop", message: "halt" },
      });
      expect(core.queued.next).toEqual([]);
      expect(userTexts(core)).toContain("queued");
      suspend = false;
      void core.send([{ type: "user", text: "resume" }]);
      const resumed = await awaitNextStream(mockClient, stream);
      expect(userTexts(core).filter((t) => t === "queued")).toHaveLength(1);
      resumed.finishResponse("end_turn");
    } finally {
      await core.destroy();
      await cleanupArchive(threadId);
    }
  });
  it("keeps a system reminder pending across a suspended request", async () => {
    const threadId = uniqueThreadId("reminder-suspend");
    const { core, mockClient } = createAgentWithMock(undefined, threadId);
    try {
      let suspend = true;
      core.hooks = composeSupervisors(() => [
        {
          onBeforeRequest: () =>
            Promise.resolve(
              suspend
                ? {
                    type: "suspend" as const,
                    reason: { kind: "stop" as const, message: "halt" },
                  }
                : { type: "none" as const },
            ),
        },
      ]);
      expect(await core.send([{ type: "user", text: "start" }])).toEqual({
        type: "suspended",
        reason: { kind: "stop", message: "halt" },
      });
      // A reminder placed in a request that is never issued would be marked
      // sent and silently lost.
      expect(mockClient.streams).toHaveLength(0);
      expect(JSON.stringify(core.getProviderMessages())).not.toContain(
        "system-reminder",
      );
      suspend = false;
      void core.send([{ type: "user", text: "resume" }]);
      const stream = await mockClient.awaitStream();
      expect(JSON.stringify(stream.messages)).toContain("Remember the skills");
      stream.finishResponse("end_turn");
    } finally {
      await core.destroy();
      await cleanupArchive(threadId);
    }
  });
  it("carries a queue flushed for a suspended request onto the handoff", async () => {
    const threadId = uniqueThreadId("deferred-compact");
    const calls: string[] = [];
    const { core, mockClient } = createAgentWithMock(
      undefined,
      threadId,
      (message) => {
        calls.push(message);
        return Promise.resolve({
          compact: false,
          messages: [{ type: "user" as const, text: message }],
          reminders: [],
        });
      },
    );
    try {
      let compacted = false;
      let requests = 0;
      core.hooks = composeSupervisors(() => [
        {
          onBeforeRequest: () =>
            Promise.resolve(
              !compacted && ++requests > 1
                ? {
                    type: "suspend" as const,
                    reason: { kind: "compact", nextPrompt: undefined },
                  }
                : { type: "none" as const },
            ),
        },
      ]);
      let queueAtHandoff = -1;
      let callsAtHandoff = -1;
      const compactor: Compactor = {
        run: () => {
          compacted = true;
          queueAtHandoff = core.queued.next.length;
          callsAtHandoff = calls.length;
          return Promise.resolve({
            type: "complete",
            summary: "SUMMARY TEXT",
            chunkCount: 1,
          });
        },
      };

      void runSubmission({
        thread: core,
        compactor,
        start: () => core.send([{ type: "user", text: "start" }]),
      });
      const stream = await mockClient.awaitStream();
      await core.submit(pendingMessage("queued"), "next");
      stream.finishResponse("end_turn");

      // The stop flushed the queue for the request the gate then refused to
      // issue. Resolution is not repeatable, so rather than being resolved a
      // second time the content travels on the handoff itself: it becomes the
      // compaction's follow-up prompt.
      const contStream = await awaitNextStream(mockClient, stream);
      expect(queueAtHandoff).toBe(0);
      expect(callsAtHandoff).toBe(1);
      // Delivered by the post-compaction request itself, exactly once.
      expect(userTexts(core)).toContain("queued");
      expect(calls).toEqual(["queued"]);
      expect(core.queued.next).toEqual([]);
      contStream.streamText("resumed");
      contStream.finishResponse("end_turn");
    } finally {
      await core.destroy();
      await cleanupArchive(threadId);
    }
  });
});

describe("Thread.send while busy", () => {
  it("discards the queues when the caller sends now instead", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.send([{ type: "user", text: "start" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("working");
    await core.submit(pendingMessage("queued async"), "async");
    await core.submit(pendingMessage("queued next"), "next");

    // Sending now supersedes whatever was waiting on the aborted turn.
    void core.send([{ type: "user", text: "never mind, do this" }]);
    const second = await awaitNextStream(mockClient, stream);
    expect(core.queued.async).toEqual([]);
    expect(core.queued.next).toEqual([]);
    const texts = userTexts(core);
    expect(texts).not.toContain("queued async");
    expect(texts).not.toContain("queued next");
    expect(texts).toContain("never mind, do this");
    second.finishResponse("end_turn");
  });
});

describe("Thread.abort between turns", () => {
  it("stops the loop instead of issuing the continuation", async () => {
    const entered = new Defer<void>();
    const gate = new Defer<void>();
    const resolved: string[] = [];
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("abort-between-turns"),
      async (message) => {
        entered.resolve();
        await gate.promise;
        resolved.push(renderPending(message));
        return {
          compact: false,
          messages: [{ type: "user" as const, text: renderPending(message) }],
          reminders: [],
        };
      },
    );
    const sent = core.send([{ type: "user", text: "start" }]);
    const stream = await mockClient.awaitStream();
    await core.submit(pendingMessage("queued follow-up"), "next");
    stream.streamText("ok");
    stream.finishResponse("end_turn");
    // The agent has settled and has nothing in flight to interrupt; the loop
    // is between turns, preparing the continuation.
    await entered.promise;
    const streamsBefore = mockClient.streams.length;
    const aborting = core.abort();
    gate.resolve();
    // Entries the drain already resolved are discarded rather than handed
    // back: the drain got there first, so there is nothing left to report.
    expect((await aborting).unsent).toEqual([]);
    expect(resolved).toEqual(["queued follow-up"]);
    expect(await sent).toEqual({ type: "aborted" });
    expect(mockClient.streams.length).toBe(streamsBefore);
  });

  it("issues no continuation when the abort races the stop", async () => {
    let onUpdate: () => void = () => {};
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("abort-at-stop"),
      undefined,
      () => onUpdate(),
    );
    const stopConsultations: string[] = [];
    let requests = 0;
    core.hooks = composeSupervisors(() => [
      {
        onBeforeRequest: () => {
          if (++requests > 1) stopConsultations.push("continuation");
          return Promise.resolve({ type: "none" as const });
        },
      },
    ]);
    const sent = core.send([{ type: "user", text: "start" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("ok");
    const streamsBefore = mockClient.streams.length;
    let aborting: Promise<unknown> | undefined;
    let aborted = false;
    // The abort lands as the turn is finishing, so it is the agent that
    // reports it — the loop must take that at face value rather than
    // treating the stop as a turn boundary to continue from.
    onUpdate = () => {
      if (aborted || core.phase.type !== "idle") return;
      aborted = true;
      aborting = core.abort();
    };
    stream.finishResponse("end_turn");
    await aborting;
    expect(await sent).toEqual({ type: "aborted" });
    // No stop was ever presented to the supervisors, so nothing decided to
    // follow it.
    expect(stopConsultations).toEqual([]);
    expect(mockClient.streams.length).toBe(streamsBefore);
  });
});

describe("Thread.abort returns the unsent queue", () => {
  const queuedText = (unsent: ReadonlyArray<QueuedMessage>) =>
    unsent.map((q) => renderPending(q.message)).join("\n");

  it("drains the queue and hands it back to whoever aborted", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("partial response");
    for (const text of [
      pendingMessage("queued one"),
      pendingMessage("queued two"),
    ]) {
      await core.submit(text, "async");
    }
    const { unsent } = await core.abort();
    expect(core.queued.async).toEqual([]);
    expect(queuedText(unsent)).toBe("queued one\nqueued two");
  });

  it("returns an empty list when nothing was queued", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("partial response");
    const { unsent } = await core.abort();
    expect(unsent).toEqual([]);
    expect(core.queued.async).toEqual([]);
  });

  it("returns every queued entry; filtering is the consumer's policy", async () => {
    const { core, mockClient } = createAgentWithMock();
    void core.send([{ type: "user", text: "hello" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("partial response");
    for (const text of [
      pendingMessage("queued user"),
      pendingMessage("queued other"),
    ]) {
      await core.submit(text, "async");
    }
    const { unsent } = await core.abort();
    expect(core.queued.async).toEqual([]);
    expect(unsent).toHaveLength(2);
    expect(queuedText(unsent)).toBe("queued user\nqueued other");
  });

  it("reports the queue for a subagent thread as well", async () => {
    const { core, mockClient } = createAgentWithMock({
      threadType: "subagent" as ThreadType,
    });
    void core.send([{ type: "user", text: "do the task" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("partial response");
    for (const text of [pendingMessage("queued")]) {
      await core.submit(text, "async");
    }
    const { unsent } = await core.abort();
    expect(queuedText(unsent)).toBe("queued");
    expect(core.queued.async).toEqual([]);
  });
});

describe("system-info preamble", () => {
  /** The injection is classified on append, so it is not a plain text block. */
  const preambles = (core: Thread) =>
    core
      .getProviderMessages()
      .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
      .filter((b) => b.type === "system_info").length;

  it("rides the first request only, and the first one after a reset", async () => {
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("system-info-preamble"),
    );
    // One instance, not one per consultation: the supervisor's own state is
    // what decides which request carries the preamble.
    const systemInfo = new SystemInfoSupervisor(core.state.systemInfo, {
      alreadyInjected: false,
    });
    core.hooks = composeSupervisors(() => [systemInfo]);
    const first = core.send([{ type: "user", text: "one" }]);
    const stream = await mockClient.awaitStream();
    stream.finishResponse("end_turn");
    await first;
    expect(preambles(core)).toBe(1);

    const second = core.send([{ type: "user", text: "two" }]);
    const stream2 = await awaitNextStream(mockClient, stream);
    stream2.finishResponse("end_turn");
    await second;
    expect(preambles(core)).toBe(1);

    // The replacement agent starts from an empty log, so the preamble is due
    // again — the supervisor list survives the swap and has to be re-armed.
    await core.reset({ seed: [], archive: { type: "none" } });
    const third = core.send([{ type: "user", text: "three" }]);
    const stream3 = await awaitNextStream(mockClient, stream2);
    stream3.finishResponse("end_turn");
    await third;
    expect(preambles(core)).toBe(1);
  });
});

describe("empty send gate", () => {
  it("issues a request for an empty send when a supervisor has content", async () => {
    const { core, mockClient } = createAgentWithMock();
    core.hooks = composeSupervisors(() => [
      {
        hasPendingContent: () => Promise.resolve(true),
        onBeforeRequest: () => Promise.resolve(injectText("# context update")),
      },
    ]);
    const sent = core.send([]);
    const stream = await mockClient.awaitStream();
    expect(userTexts(core)).toContain("# context update");
    stream.finishResponse("end_turn");
    expect(await sent).toEqual({ type: "completed", stopReason: "end_turn" });
  });

  it("issues no request for an empty send when nothing is pending", async () => {
    const { core, mockClient } = createAgentWithMock();
    core.hooks = composeSupervisors(() => [
      { hasPendingContent: () => Promise.resolve(false) },
    ]);
    expect(await core.send([])).toEqual({
      type: "completed",
      stopReason: undefined,
    });
    expect(mockClient.streams.length).toBe(0);
  });

  it("issues no request for a standing reminder alone, and still delivers it later", async () => {
    const { core, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("empty-send-reminder"),
      (message) =>
        Promise.resolve({
          compact: false,
          messages: message ? [{ type: "user" as const, text: message }] : [],
          reminders: ["stay on task"],
        }),
    );
    core.hooks = composeSupervisors(() => [
      { hasPendingContent: () => Promise.resolve(false) },
    ]);
    expect(await core.submit(pendingMessage(""))).toEqual({
      type: "completed",
      stopReason: undefined,
    });
    expect(mockClient.streams.length).toBe(0);

    const sent = core.send([{ type: "user", text: "now do it" }]);
    const stream = await mockClient.awaitStream();
    const request = stream.messages[stream.messages.length - 1];
    expect(JSON.stringify(request.content)).toContain("stay on task");
    stream.finishResponse("end_turn");
    await sent;
  });

  it("supersedes an empty send whose probe is still in flight", async () => {
    const { core, mockClient } = createAgentWithMock();
    const probe = new Defer<boolean>();
    core.hooks = composeSupervisors(() => [
      { hasPendingContent: () => probe.promise },
    ]);
    const first = core.send([]);
    const second = core.send([{ type: "user", text: "go" }]);
    probe.resolve(true);
    expect(await first).toEqual({ type: "aborted" });
    const stream = await mockClient.awaitStream();
    expect(mockClient.streams.length).toBe(1);
    expect(core.isBusy).toBe(true);
    stream.finishResponse("end_turn");
    expect(await second).toEqual({ type: "completed", stopReason: "end_turn" });
    expect(core.isBusy).toBe(false);
  });
  it("does not consume pending content when the send is gated off", async () => {
    const { core, mockClient } = createAgentWithMock();
    let available = false;
    const supervisor = {
      hasPendingContent: () => Promise.resolve(available),
      onBeforeRequest: () =>
        Promise.resolve(
          available
            ? injectText("# context update")
            : { type: "none" as const },
        ),
    };
    core.hooks = composeSupervisors(() => [supervisor]);
    await core.send([]);
    expect(mockClient.streams.length).toBe(0);

    available = true;
    const sent = core.send([{ type: "user", text: "go" }]);
    const stream = await mockClient.awaitStream();
    expect(userTexts(core)).toContain("# context update");
    stream.finishResponse("end_turn");
    await sent;
  });
});
