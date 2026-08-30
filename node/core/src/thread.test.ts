import { describe, expect, it } from "vitest";
import type { AgentContext } from "./agent.ts";
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
import type { QueuedMessage } from "./thread-api.ts";
import { composeSupervisors } from "./thread-supervisor.ts";
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
      if (core.state.mode.type === "tool_use") return true;
      throw new Error(`waiting for tool_use, got ${core.state.mode.type}`);
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

  it("leaves the queues intact and unresolved across a compaction handoff", async () => {
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
      core.hooks = composeSupervisors(() => [
        {
          onBeforeRequest: (ctx) =>
            Promise.resolve(
              !compacted && ctx.kind !== "submission"
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

      // The handoff issued no request, so the queue is neither drained nor
      // resolved: its commands must run against the world as it is at
      // delivery, on the far side of the swap.
      const contStream = await awaitNextStream(mockClient, stream);
      expect(queueAtHandoff).toBe(1);
      expect(callsAtHandoff).toBe(0);

      contStream.streamText("resumed");
      contStream.finishResponse("end_turn");

      const afterStream = await awaitNextStream(mockClient, contStream);
      expect(calls).toEqual(["queued"]);
      expect(core.queued.next).toEqual([]);
      expect(userTexts(core)).toContain("queued");
      afterStream.finishResponse("end_turn");
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
    core.hooks = composeSupervisors(() => [
      {
        onBeforeRequest: (ctx) => {
          if (ctx.kind !== "submission") stopConsultations.push(ctx.kind);
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
