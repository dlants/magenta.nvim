import { describe, expect, it } from "vitest";
import type { ThreadId, ThreadType } from "../chat-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "../providers/provider-types.ts";
import { pendingMessage } from "../submission/index.ts";
import { createAgentWithMock, uniqueThreadId } from "../test-helpers.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { Defer } from "../utils/async.ts";
import { ThreadCompactor } from "./compactor.ts";
import { type CompactionOutcome, runSubmission } from "./index.ts";

const compactStart = () =>
  Promise.resolve({
    type: "suspended" as const,
    reason: { kind: "compact" as const, nextPrompt: "continue" },
  });

describe("compaction generation ownership", () => {
  it("settles a busy turn before taking the compaction snapshot", async () => {
    const { core: thread, mockClient } = createAgentWithMock();
    const previous = thread.send([{ type: "user", text: "work" }]);
    const stream = await mockClient.awaitStream();
    stream.streamText("partial response");
    thread.callbacks.resolve = async () => ({
      compact: true,
      messages: [],
      reminders: [],
    });
    let snapshots = 0;
    const sent = runSubmission({
      thread,
      compactor: {
        run: async (messages) => {
          snapshots++;
          expect(thread.isBusy).toBe(false);
          expect(thread.core.isActive).toBe(true);
          expect(await previous).toEqual({ type: "aborted" });
          const snapshot = JSON.stringify(messages);
          await Promise.resolve();
          expect(JSON.stringify(thread.getProviderMessages())).toBe(snapshot);
          return { type: "aborted" };
        },
      },
      start: () => thread.submit(pendingMessage("@compact")),
    });
    expect(await sent).toEqual({ type: "aborted" });
    expect(snapshots).toBe(1);
    expect(mockClient.streams).toHaveLength(1);
    await thread.destroy();
  });

  it("cancels a busy compaction while the old loop is settling", async () => {
    const { core: thread, mockClient } = createAgentWithMock();
    const entered = new Defer<void>();
    const probe = new Defer<boolean>();
    thread.hooks.hasPendingContent = () => {
      entered.resolve();
      return probe.promise;
    };
    const previous = thread.send([]);
    await entered.promise;
    thread.callbacks.resolve = async () => ({
      compact: true,
      messages: [],
      reminders: [],
    });
    const sent = thread.submit(pendingMessage("@compact"));
    await Promise.resolve();
    expect(thread.loopState).toMatchObject({ type: "running", aborting: true });
    await thread.abort();
    probe.resolve(true);
    expect(await previous).toEqual({ type: "aborted" });
    expect(await sent).toEqual({ type: "aborted" });
    expect(thread.core.isActive).toBe(true);
    expect(mockClient.streams).toHaveLength(0);
    await thread.destroy();
  });

  it("does not continue when reset disposal is interrupted", async () => {
    const { core: thread, mockClient } = createAgentWithMock();
    const original = thread.core;
    const dispose = original.dispose.bind(original);
    original.dispose = async () => {
      await dispose();
      await thread.abort();
    };
    expect(
      await runSubmission({
        thread,
        compactor: {
          run: async () => ({
            type: "complete",
            summary: "summary",
            chunkCount: 1,
          }),
        },
        start: compactStart,
      }),
    ).toEqual({ type: "aborted" });
    expect(thread.core).not.toBe(original);
    expect(thread.core.isActive).toBe(true);
    expect(mockClient.streams).toHaveLength(0);
    await thread.destroy();
  });

  it("yields to the original result promise using the original schema after compaction", async () => {
    const schema = {
      type: "object" as const,
      properties: { answer: { type: "integer" as const } },
      required: ["answer"],
      additionalProperties: false,
    };
    const { core: thread, mockClient } = createAgentWithMock(
      {
        threadType: "subagent" as ThreadType,
        yieldSchema: schema,
      },
      uniqueThreadId("compact-yield"),
    );
    const originalResult = thread.result;
    const originalCore = thread.core;
    const sent = runSubmission({
      thread,
      compactor: {
        run: async () => ({
          type: "complete",
          summary: "work so far",
          chunkCount: 1,
        }),
      },
      start: compactStart,
    });
    const stream = await mockClient.awaitStream();
    expect(thread.core).not.toBe(originalCore);
    expect(thread.result).toBe(originalResult);
    const yieldTool = thread.core.toolSpecs.find(
      (tool) => tool.name === "yield_to_parent",
    );
    expect(yieldTool?.input_schema).toEqual(schema);
    stream.streamToolUse(
      "compact-yield" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { answer: 42 },
    );
    stream.finishResponse("end_turn");
    const expected = {
      type: "yielded",
      value: { type: "structured", value: { answer: 42 } },
    };
    expect(await sent).toEqual(expected);
    expect(await originalResult).toEqual(expected);
    await thread.destroy();
  });

  it.each([
    "reset",
    "destroy",
    "abort",
  ] as const)("does not apply a stale summary after %s", async (action) => {
    const { core: thread, mockClient } = createAgentWithMock(
      undefined,
      uniqueThreadId("stale-compact"),
    );
    const entered = new Defer<void>();
    const outcome = new Defer<CompactionOutcome>();
    const sent = runSubmission({
      thread,
      compactor: {
        run: () => {
          entered.resolve();
          return outcome.promise;
        },
      },
      start: compactStart,
    });
    await entered.promise;
    if (action === "reset")
      await thread.reset({
        seed: [{ type: "user", text: "newer seed" }],
        archive: { type: "none" },
      });
    else if (action === "abort") await thread.abort();
    else await thread.destroy();
    const replacement = thread.core;
    outcome.resolve({ type: "complete", summary: "stale", chunkCount: 1 });
    expect(await sent).toEqual({ type: "aborted" });
    expect(thread.core).toBe(replacement);
    expect(mockClient.streams).toHaveLength(0);
    await thread.destroy();
  });
});

describe("ThreadCompactor cancellation", () => {
  it.each([
    "discard",
    "destroy",
    "abort",
    "reset",
  ] as const)("cleans up a child whose first spawn settles after %s", async (action) => {
    const spawn = new Defer<ThreadId>();
    const spawned = new Defer<void>();
    const deleted: ThreadId[] = [];
    const { core: thread } = createAgentWithMock(
      {
        threadManager: {
          spawnThread: () => {
            spawned.resolve();
            return spawn.promise;
          },
          deleteThread: (id) => {
            deleted.push(id);
          },
          awaitThreadResult: () => {
            throw new Error("cancelled child must not be awaited");
          },
        },
      },
      uniqueThreadId("compact-spawn-race"),
    );
    const compactor = new ThreadCompactor(thread);
    const run = compactor.run(
      [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "history",
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            },
          ],
        },
      ],
      undefined,
    );
    await spawned.promise;
    if (action === "discard") compactor.discard();
    else if (action === "abort") await thread.abort();
    else if (action === "reset")
      await thread.reset({ seed: [], archive: { type: "none" } });
    else await thread.destroy();
    const child = "late-child" as ThreadId;
    spawn.resolve(child);
    expect(await run).toEqual({ type: "aborted" });
    expect(deleted).toEqual([child]);
    expect(compactor.current).toBeUndefined();
    await thread.destroy();
  });
});

it("a late first spawn cannot overwrite a newer compaction", async () => {
  const firstSpawn = new Defer<ThreadId>();
  const childResult = new Defer<import("../thread-api.ts").ThreadResult>();
  const deleted: ThreadId[] = [];
  let spawnCount = 0;
  const newerChild = "newer-child" as ThreadId;
  const { core: thread } = createAgentWithMock(
    {
      threadManager: {
        spawnThread: async () =>
          ++spawnCount === 1 ? firstSpawn.promise : newerChild,
        deleteThread: (id) => {
          deleted.push(id);
          if (id === newerChild)
            childResult.resolve({ type: "aborted", reason: "deleted" });
        },
        awaitThreadResult: () => childResult.promise,
      },
    },
    uniqueThreadId("compact-spawn-superseded"),
  );
  const messages = [
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text: "history",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ],
    },
  ];
  const compactor = new ThreadCompactor(thread);
  const first = compactor.run(messages, undefined);
  const second = compactor.run(messages, undefined);
  await Promise.resolve();
  const newer = compactor.current;
  expect(newer?.activeThreadId).toBe(newerChild);
  const oldChild = "old-child" as ThreadId;
  firstSpawn.resolve(oldChild);
  expect(await first).toEqual({ type: "aborted" });
  expect(compactor.current).toBe(newer);
  expect(deleted).toEqual([oldChild]);
  compactor.discard();
  await second;
  await thread.destroy();
});

it.each([
  "destroy",
  "abort",
  "reset",
  "destroy-after-yield",
] as const)("%s deletes the compactor child and settles a parked run", async (action) => {
  const childResult = new Defer<import("../thread-api.ts").ThreadResult>();
  const waiting = new Defer<void>();
  const deleted: ThreadId[] = [];
  const child = "parked-child" as ThreadId;
  const { core: thread, mockClient } = createAgentWithMock(
    {
      threadManager: {
        spawnThread: async () => child,
        deleteThread: (id) => {
          deleted.push(id);
          childResult.resolve({ type: "aborted", reason: "deleted" });
        },
        awaitThreadResult: () => {
          waiting.resolve();
          return childResult.promise;
        },
      },
    },
    uniqueThreadId("compact-parent-destroy"),
  );
  if (action === "destroy-after-yield") {
    const sent = thread.send([{ type: "user", text: "yield" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse(
      "prior-yield" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "done" },
    );
    stream.finishResponse("end_turn");
    expect((await sent).type).toBe("yielded");
    expect((await thread.result).type).toBe("yielded");
  }
  const compactor = new ThreadCompactor(thread);
  const run = compactor.run(
    [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "history",
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          },
        ],
      },
    ],
    undefined,
  );
  await waiting.promise;
  expect(thread.isBusy).toBe(false);
  if (action === "abort") await thread.abort();
  else if (action === "reset")
    await thread.reset({ seed: [], archive: { type: "none" } });
  else await thread.destroy();
  expect(await run).toEqual({ type: "aborted" });
  expect(deleted).toEqual([child]);
  expect(compactor.current).toBeUndefined();
  await thread.destroy();
});

it("does not continue when an onReset callback aborts the compaction", async () => {
  const { core: thread, mockClient } = createAgentWithMock(
    undefined,
    uniqueThreadId("compact-reset-callback"),
  );
  thread.hooks.onReset = () => {
    void thread.abort();
  };
  expect(
    await runSubmission({
      thread,
      compactor: {
        run: async () => ({
          type: "complete",
          summary: "summary",
          chunkCount: 1,
        }),
      },
      start: compactStart,
    }),
  ).toEqual({ type: "aborted" });
  expect(mockClient.streams).toHaveLength(0);
  await thread.destroy();
});

it("an immediate submission supersedes a parked compaction before resolution", async () => {
  const entered = new Defer<void>();
  const outcome = new Defer<CompactionOutcome>();
  const resolution = new Defer<
    Awaited<ReturnType<import("../submission/index.ts").ResolveSubmission>>
  >();
  const { core: thread, mockClient } = createAgentWithMock(
    undefined,
    uniqueThreadId("compact-submit"),
  );
  const sent = runSubmission({
    thread,
    compactor: {
      run: () => {
        entered.resolve();
        return outcome.promise;
      },
    },
    start: compactStart,
  });
  await entered.promise;
  thread.callbacks.resolve = () => resolution.promise;
  const next = thread.submit(pendingMessage("new prompt"));
  outcome.resolve({ type: "complete", summary: "stale", chunkCount: 1 });
  expect(await sent).toEqual({ type: "aborted" });
  expect(mockClient.streams).toHaveLength(0);
  await thread.abort();
  resolution.resolve({ messages: [], reminders: [], compact: false });
  expect(await next).toEqual({ type: "aborted" });
  await thread.destroy();
});
