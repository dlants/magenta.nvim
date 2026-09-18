import { afterEach, expect, it, vi } from "vitest";
import type { ThreadId } from "./chat-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./providers/provider-types.ts";
import { type PreparedThread, Session, type SessionHost } from "./session.ts";
import { pendingMessage, renderPending } from "./submission/index.ts";
import {
  awaitNextStream,
  createAgentWithMock,
  TEST_ARCHIVE_DIR,
  uniqueThreadId,
} from "./test-helpers.ts";
import type { PreparedThreadContext } from "./thread-assembly.ts";
import {
  AutoCompactSupervisor,
  MaxTokensSupervisor,
  SubagentSupervisor,
} from "./thread-supervisor.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";
import { Defer } from "./utils/async.ts";

const sessions: Session[] = [];
const threads: { destroy: () => Promise<void> }[] = [];

/** A session over a mock-backed preparation: no editor, no view, no dispatch. */
function fixture(prepareThread?: SessionHost["prepareThread"]) {
  const base = createAgentWithMock(undefined, uniqueThreadId("session"));
  threads.push(base.core);
  const {
    threadType: _threadType,
    chatSupervisors: _chatSupervisors,
    compactor: _compactor,
    ...context
  } = base.context;
  const prepared: PreparedThread = {
    context: context as PreparedThreadContext,
    autoCompactThreshold: 100_000,
    autoCompactPrompt: "continue",
    archiveBaseDir: TEST_ARCHIVE_DIR,
  };
  const session = new Session({
    prepareThread: prepareThread ?? (async () => prepared),
    getActiveProfile: () => base.context.profile,
  });
  sessions.push(session);
  return { session, prepared, ...base };
}

/** Threads created through a fixture archive under the test directory. */
function rootOptions(profile: ReturnType<SessionHost["getActiveProfile"]>) {
  return { profile, threadType: "root" as const };
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  await Promise.all(threads.splice(0).map((thread) => thread.destroy()));
});

it("owns construction and fork policies with no view attached", async () => {
  const { session } = fixture();
  const id = await session.createRootThread();
  const record = session.getThread(id);
  if (record?.state !== "initialized") throw new Error("expected initialized");
  expect(
    record.thread.chatSupervisors.map((policy) => policy.constructor),
  ).toEqual([MaxTokensSupervisor, AutoCompactSupervisor]);
  // biome-ignore lint/complexity/useLiteralKeys: verify the injected execution boundary
  expect(record.thread["context"].threadManager).toBe(session);
  const forkId = await session.forkThread(id);
  const fork = session.getThread(forkId);
  if (fork?.state !== "initialized") throw new Error("expected fork");
  expect(fork.thread).not.toBe(record.thread);
  expect(fork.compactor).not.toBe(record.compactor);
  expect(fork.parentThreadId).toBeUndefined();
  expect(
    fork.thread.chatSupervisors.map((policy) => policy.constructor),
  ).toEqual([MaxTokensSupervisor, AutoCompactSupervisor]);
});

it("derives a child's profile and environment from the parent record", async () => {
  const { session, prepared } = fixture();
  prepared.context = {
    ...prepared.context,
    environmentConfig: { type: "docker", container: "remote", cwd: "/work" },
    profile: { ...prepared.context.profile, fastModel: "fast-model" },
  };
  const parentId = await session.createThread({
    profile: { ...prepared.context.profile, fastModel: "fast-model" },
    threadType: "root",
  });
  const childId = await session.spawnThread({
    parentThreadId: parentId,
    prompt: "do work",
    threadType: "subagent",
    subagentConfig: { fastModel: true },
  });
  const child = session.getThread(childId);
  if (child?.state !== "initialized") throw new Error("expected child");
  expect(child.parentThreadId).toBe(parentId);
  // The fast-model child inherits the parent's profile with the fast model.
  expect(child.options.profile.model).toBe("fast-model");
  // Environment is inherited from what the parent's construction resolved.
  expect(child.options.environmentConfig).toEqual({
    type: "docker",
    container: "remote",
    cwd: "/work",
  });
});

it("settles preparation failures and rejects unknown result ids", async () => {
  const { session, context } = fixture(async () => {
    throw new Error("preparation failed");
  });
  const id = uniqueThreadId("session-failure");
  const creation = session.createThread({
    threadId: id,
    ...rootOptions(context.profile),
  });
  const result = session.awaitThreadResult(id);
  await expect(creation).rejects.toThrow("preparation failed");
  expect(session.getThread(id)?.state).toBe("error");
  await expect(result).resolves.toMatchObject({
    type: "aborted",
    reason: expect.stringContaining("preparation failed"),
  });
  await expect(
    session.awaitThreadResult("unknown" as ThreadId),
  ).rejects.toThrow("Unknown thread");
});

it("invalidates pending construction and awaits its late release during disposal", async () => {
  const gate = new Defer<PreparedThread>();
  const { session, context, prepared } = fixture(() => gate.promise);
  const release = vi.fn(async () => {});
  const id = uniqueThreadId("session-pending");
  const creation = session.createThread({
    threadId: id,
    ...rootOptions(context.profile),
  });
  const rejected = expect(creation).rejects.toThrow("cancelled");
  session.deleteThread(id);
  const disposal = session.dispose();
  gate.resolve({ ...prepared, release });
  await rejected;
  await disposal;
  expect(release).toHaveBeenCalledTimes(1);
  expect(session.getThread(id)).toBeUndefined();
  await expect(session.awaitThreadResult(id)).resolves.toEqual({
    type: "aborted",
    reason: "thread deleted",
  });
});

it("deleting a parent invalidates its in-flight child and leaves other roots alone", async () => {
  const gate = new Defer<PreparedThread>();
  const { session, prepared, context } = fixture(async (request) =>
    request.options.parent ? gate.promise : prepared,
  );
  const root = await session.createRootThread();
  const other = await session.createRootThread();
  const child = uniqueThreadId("session-child");
  const creation = session.createThread({
    threadId: child,
    parent: root,
    profile: context.profile,
    threadType: "compact",
  });
  const rejected = expect(creation).rejects.toThrow("cancelled");
  session.deleteThread(root);
  gate.resolve(prepared);
  await rejected;
  expect(session.listThreads().map((record) => record.id)).toEqual([other]);
  await expect(session.awaitThreadResult(child)).resolves.toMatchObject({
    type: "aborted",
  });
});

it("aborts pending preparation and releases a late environment exactly once", async () => {
  const gate = new Defer<PreparedThread>();
  const { session, context, prepared } = fixture(() => gate.promise);
  const release = vi.fn(async () => {});
  const id = uniqueThreadId("session-aborted");
  const creation = session.createThread({
    threadId: id,
    ...rootOptions(context.profile),
  });
  const rejected = expect(creation).rejects.toThrow("cancelled");
  await session.abortThread(id);
  await expect(session.awaitThreadResult(id)).resolves.toMatchObject({
    type: "aborted",
  });
  gate.resolve({ ...prepared, release });
  await rejected;
  expect(session.getThread(id)?.state).toBe("error");
  await session.dispose();
  expect(release).toHaveBeenCalledTimes(1);
});

it("compact children get no compactor and no auto-compaction policy", async () => {
  const { session, context } = fixture();
  const id = await session.createThread({
    profile: context.profile,
    threadType: "compact",
  });
  const record = session.getThread(id);
  if (record?.state !== "initialized") throw new Error("expected initialized");
  expect(record.compactor).toBeUndefined();
  const forkId = await session.forkThread(id);
  const fork = session.getThread(forkId);
  if (fork?.state !== "initialized") throw new Error("expected fork");
  expect(fork.compactor).toBeUndefined();
  expect(
    fork.thread.chatSupervisors.map((policy) => policy.constructor),
  ).toEqual([MaxTokensSupervisor, SubagentSupervisor]);
});

it("runs bootstrap input and settles a yield with no dispatch involved", async () => {
  const { session, context, mockClient } = fixture();
  const id = await session.createThread({
    profile: context.profile,
    threadType: "subagent",
    label: "Headless worker",
    inputMessages: [
      {
        type: "text",
        text: "work",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ],
  });
  const record = session.getThread(id);
  if (record?.state !== "initialized") throw new Error("expected initialized");
  expect(record.thread.title).toBe("Headless worker");
  const stream = await mockClient.awaitStream();
  stream.streamToolUse(
    "session-yield" as ToolRequestId,
    "yield_to_parent" as ToolName,
    { result: "finished" },
  );
  stream.finishResponse("end_turn");
  await expect(session.awaitThreadResult(id)).resolves.toEqual({
    type: "yielded",
    value: { result: "finished" },
  });
  // A retained result survives deletion of the record it came from.
  session.deleteThread(id);
  await expect(session.awaitThreadResult(id)).resolves.toMatchObject({
    type: "yielded",
  });
});

it("rejects approvals on deletion and releases environments even when destruction fails", async () => {
  const { context, prepared } = fixture();
  const release = vi.fn(async () => {});
  const rejectApprovals = vi.fn();
  const session = new Session({
    prepareThread: async () => ({ ...prepared, release }),
    getActiveProfile: () => context.profile,
    rejectApprovals,
  });
  sessions.push(session);
  const id = await session.createRootThread();
  const record = session.getThread(id);
  if (record?.state !== "initialized") throw new Error("expected initialized");
  const destroy = record.thread.destroy.bind(record.thread);
  vi.spyOn(record.thread, "destroy").mockImplementation(async () => {
    await destroy();
    throw new Error("teardown failed");
  });
  session.deleteThread(id);
  await session.dispose();
  expect(rejectApprovals).toHaveBeenCalledWith(id);
  expect(release).toHaveBeenCalledTimes(1);
});

it("uses the prepared environment when checking whether a fork is local", async () => {
  const { session, context, prepared } = fixture();
  prepared.context = {
    ...prepared.context,
    environmentConfig: {
      type: "docker",
      container: "remote",
      cwd: "/workspace",
    },
  };
  const id = await session.createThread(rootOptions(context.profile));
  expect(() => session.forkThread(id)).toThrow("local-source forks");
});

it("freezes a fork at the requested index even if the source advances", async () => {
  const gate = new Defer<PreparedThread>();
  const { session, prepared, mockClient } = fixture(async (request) =>
    request.type === "fork" ? gate.promise : prepared,
  );
  prepared.context = {
    ...prepared.context,
    resolve: async (message) => ({
      compact: false,
      reminders: [message],
      messages: [
        {
          type: "text",
          text: message,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ],
    }),
  };
  const id = await session.createRootThread();
  const record = session.getThread(id);
  if (record?.state !== "initialized") throw new Error("expected source");
  const first = record.thread.submit({
    type: "raw",
    message: pendingMessage("original reminder"),
  });
  const firstStream = await mockClient.awaitStream();
  firstStream.streamText("original answer");
  firstStream.finishResponse("end_turn");
  await first;
  const originalMessages = structuredClone(record.thread.getProviderMessages());
  const forkCreation = session.forkThread(id);
  const second = record.thread.submit({
    type: "raw",
    message: pendingMessage("later reminder"),
  });
  const secondStream = await awaitNextStream(mockClient, firstStream);
  secondStream.streamText("later answer");
  secondStream.finishResponse("end_turn");
  await second;
  // Policy changes after the request cannot reshape the fork: it inherits the
  // source's compaction settings, not the host's current defaults.
  prepared.autoCompactThreshold = 1;
  prepared.autoCompactPrompt = "changed policy";
  gate.resolve(prepared);
  const forkId = await forkCreation;
  const fork = session.getThread(forkId);
  if (fork?.state !== "initialized") throw new Error("expected fork");
  expect(fork.thread.getProviderMessages()).toEqual(originalMessages);
  expect([...fork.thread.activeReminders]).toEqual(["original reminder"]);
  const policy = AutoCompactSupervisor.find(fork.thread.chatSupervisors)!;
  expect(
    policy.onEndTurnWithoutYield({
      stopReason: "end_turn",
      inputTokenCount: 100_000,
      lastAssistantMessage: undefined,
      nativeMessageIdx: fork.thread.nativeMessageIdx,
    }),
  ).toEqual({
    type: "suspend",
    reason: { kind: "compact", nextPrompt: "continue" },
  });
});

it("aborts the subtree but returns only the requested thread's unsent input", async () => {
  const { session } = fixture();
  const root = await session.createRootThread();
  const child = await session.spawnThread({
    parentThreadId: root,
    prompt: "child work",
    threadType: "subagent",
  });
  const grandchild = await session.spawnThread({
    parentThreadId: child,
    prompt: "grandchild work",
    threadType: "subagent",
  });
  const threadOf = (id: ThreadId) => {
    const record = session.getThread(id);
    if (record?.state !== "initialized") throw new Error("expected thread");
    return record.thread;
  };
  void threadOf(root)
    .submit({ type: "raw", message: pendingMessage("root work") })
    .catch(() => {});
  // Queued behind the busy turn on both ends of the subtree.
  void threadOf(root)
    .submit({ type: "raw", message: pendingMessage("root leftover") }, "next")
    .catch(() => {});
  void threadOf(grandchild)
    .submit({ type: "raw", message: pendingMessage("deep leftover") }, "next")
    .catch(() => {});
  const { unsent } = await session.abortThread(root);
  expect(unsent.map((queued) => renderPending(queued.message))).toEqual([
    "root leftover",
  ]);
  for (const id of [root, child, grandchild]) {
    expect(threadOf(id).isBusy).toBe(false);
  }
  // A descendant's leftover input is discarded, not handed to the caller.
  expect(
    (await threadOf(grandchild).abort()).unsent.map((queued) =>
      renderPending(queued.message),
    ),
  ).toEqual([]);
  await expect(session.abortThread("unknown" as ThreadId)).resolves.toEqual({
    unsent: [],
  });
});
it("destroys and releases a thread whose record is deleted after assembly", async () => {
  const { context, prepared } = fixture();
  const release = vi.fn(async () => {});
  const session = new Session({
    prepareThread: async () => ({ ...prepared, release }),
    getActiveProfile: () => context.profile,
  });
  sessions.push(session);
  let destroy: ReturnType<typeof vi.spyOn> | undefined;
  session.on("changed", (id) => {
    const record = session.getThread(id);
    if (record?.state !== "initialized" || destroy) return;
    destroy = vi.spyOn(record.thread, "destroy");
    session.deleteThread(id);
  });
  await expect(session.createRootThread()).rejects.toThrow("cancelled");
  await session.dispose();
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});
it("refuses to reuse a thread id that is already registered", async () => {
  const { session, context } = fixture();
  const id = uniqueThreadId("session-duplicate");
  await session.createThread({ threadId: id, ...rootOptions(context.profile) });
  await expect(
    session.createThread({ threadId: id, ...rootOptions(context.profile) }),
  ).rejects.toThrow("already exists");
  expect(session.listThreads().map((record) => record.id)).toEqual([id]);
});
it("keeps two sessions' registries independent", async () => {
  const a = fixture();
  const b = fixture();
  const id = await a.session.createRootThread();
  expect(b.session.getThread(id)).toBeUndefined();
  await expect(b.session.awaitThreadResult(id)).rejects.toThrow(
    "Unknown thread",
  );
  await expect(
    b.session.spawnThread({
      parentThreadId: id,
      prompt: "work",
      threadType: "subagent",
    }),
  ).rejects.toThrow("not available");
  expect(a.session.listThreads().map((record) => record.id)).toEqual([id]);
  expect(TEST_ARCHIVE_DIR).toBeTruthy();
});
