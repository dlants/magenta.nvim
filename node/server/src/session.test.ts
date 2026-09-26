import { afterEach, expect, it, vi } from "vitest";
import type { ThreadId } from "./chat-types.ts";
import type { ProviderProfile } from "./provider-options.ts";
import { pendingMessage, renderPending } from "./submission/index.ts";
import {
  createHarness,
  type Harness,
  type TestSessionHost,
} from "./test/harness.ts";
import {
  awaitNextStream,
  created,
  sendResolved,
  TEST_ARCHIVE_DIR,
  uniqueThreadId,
} from "./test-helpers.ts";
import { ABORTED } from "./thread-api.ts";
import { TitleSupervisor } from "./thread-assembly.ts";
import {
  MaxTokensSupervisor,
  SubagentSupervisor,
} from "./thread-supervisor.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";
import { Defer } from "./utils/async.ts";

const harnesses: Harness[] = [];

/** A session over the node-only test host: no editor, no view, no dispatch. */
function fixture(intercept?: TestSessionHost["intercept"]) {
  const harness = createHarness();
  harness.host.intercept = intercept;
  harnesses.push(harness);
  return { ...harness, profile: harness.host.profile };
}

function withRelease(
  release: () => Promise<void>,
): TestSessionHost["intercept"] {
  return async (_request, prepare) => ({ ...(await prepare()), release });
}

function rootOptions(profile: ProviderProfile) {
  return { profile, threadType: "root" as const };
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

it("owns construction and fork policies with no view attached", async () => {
  const { session } = fixture();
  const id = await created(session.createRootThread());
  const record = session.getThread(id);
  if (record?.state !== "initialized") throw new Error("expected initialized");
  expect(
    record.thread.submissionSupervisors.map((policy) => policy.constructor),
  ).toEqual([MaxTokensSupervisor, TitleSupervisor]);
  // biome-ignore lint/complexity/useLiteralKeys: verify the injected execution boundary
  expect(record.thread["context"].threadManager).toBe(session);
  const forkId = await created(session.forkThread(id));
  const fork = session.getThread(forkId);
  if (fork?.state !== "initialized") throw new Error("expected fork");
  expect(fork.thread).not.toBe(record.thread);
  expect(fork.compactor).not.toBe(record.compactor);
  expect(fork.parentThreadId).toBeUndefined();
  expect(
    fork.thread.submissionSupervisors.map((policy) => policy.constructor),
  ).toEqual([MaxTokensSupervisor, TitleSupervisor]);
});

it("derives a child's profile and environment from the parent record", async () => {
  const { session, host, profile } = fixture();
  host.contextOverrides = {
    environmentConfig: { type: "docker", container: "remote", cwd: "/work" },
  };
  const parentId = await created(
    session.createThread({
      profile: { ...profile, fastModel: "fast-model" },
      threadType: "root",
    }),
  );
  const childId = await created(
    session.spawnThread({
      parentThreadId: parentId,
      prompt: "do work",
      threadType: "subagent",
      subagentConfig: { fastModel: true },
    }),
  );
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
  const { session, profile } = fixture(async () => {
    throw new Error("preparation failed");
  });
  const id = uniqueThreadId("session-failure");
  const creation = session.createThread({
    threadId: id,
    ...rootOptions(profile),
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
  const gate = new Defer<void>();
  const release = vi.fn(async () => {});
  const { session, profile } = fixture(async (request, prepare) => {
    await gate.promise;
    return withRelease(release)!(request, prepare);
  });
  const id = uniqueThreadId("session-pending");
  const creation = session.createThread({
    threadId: id,
    ...rootOptions(profile),
  });
  const rejected = creation.then((result) => {
    expect(result).toBe(ABORTED);
  });
  session.deleteThread(id);
  const disposal = session.dispose();
  gate.resolve();
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
  const gate = new Defer<void>();
  const { session, profile } = fixture(async (request, prepare) => {
    if (request.options.parent) await gate.promise;
    return prepare();
  });
  const root = await created(session.createRootThread());
  const other = await created(session.createRootThread());
  const child = uniqueThreadId("session-child");
  const creation = session.createThread({
    threadId: child,
    parent: root,
    profile,
    threadType: "compact",
  });
  const rejected = creation.then((result) => {
    expect(result).toBe(ABORTED);
  });
  session.deleteThread(root);
  gate.resolve();
  await rejected;
  expect(session.listThreads().map((record) => record.id)).toEqual([other]);
  await expect(session.awaitThreadResult(child)).resolves.toMatchObject({
    type: "aborted",
  });
});

it("aborts pending preparation and releases a late environment exactly once", async () => {
  const gate = new Defer<void>();
  const release = vi.fn(async () => {});
  const { session, profile } = fixture(async (request, prepare) => {
    await gate.promise;
    return withRelease(release)!(request, prepare);
  });
  const id = uniqueThreadId("session-aborted");
  const creation = session.createThread({
    threadId: id,
    ...rootOptions(profile),
  });
  const rejected = creation.then((result) => {
    expect(result).toBe(ABORTED);
  });
  await session.abortThread(id);
  await expect(session.awaitThreadResult(id)).resolves.toMatchObject({
    type: "aborted",
  });
  gate.resolve();
  await rejected;
  expect(session.getThread(id)?.state).toBe("error");
  await session.dispose();
  expect(release).toHaveBeenCalledTimes(1);
});

it("compact children get no compactor and no auto-compaction policy", async () => {
  const { session, profile } = fixture();
  const id = await created(
    session.createThread({
      profile: profile,
      threadType: "compact",
    }),
  );
  const record = session.getThread(id);
  if (record?.state !== "initialized") throw new Error("expected initialized");
  expect(record.compactor).toBeUndefined();
  const forkId = await created(session.forkThread(id));
  const fork = session.getThread(forkId);
  if (fork?.state !== "initialized") throw new Error("expected fork");
  expect(fork.compactor).toBeUndefined();
  expect(
    fork.thread.submissionSupervisors.map((policy) => policy.constructor),
  ).toEqual([MaxTokensSupervisor, SubagentSupervisor, TitleSupervisor]);
});

it("runs bootstrap input and settles a yield with no dispatch involved", async () => {
  const { session, profile, mockClient } = fixture();
  const id = await created(
    session.createThread({
      profile: profile,
      threadType: "subagent",
      label: "Headless worker",
      inputMessages: [
        {
          type: "text",
          text: "work",
        },
      ],
    }),
  );
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
  const release = vi.fn(async () => {});
  const { session, host } = fixture(withRelease(release));
  const id = await created(session.createRootThread());
  const record = session.getThread(id);
  if (record?.state !== "initialized") throw new Error("expected initialized");
  const destroy = record.thread.destroy.bind(record.thread);
  vi.spyOn(record.thread, "destroy").mockImplementation(async () => {
    await destroy();
    throw new Error("teardown failed");
  });
  session.deleteThread(id);
  await session.dispose();
  expect(host.rejectedApprovals).toContain(id);
  expect(release).toHaveBeenCalledTimes(1);
});

it("uses the prepared environment when checking whether a fork is local", async () => {
  const { session, profile, host } = fixture();
  host.contextOverrides = {
    environmentConfig: {
      type: "docker",
      container: "remote",
      cwd: "/workspace",
    },
  };
  const id = await created(session.createThread(rootOptions(profile)));
  expect(() => session.forkThread(id)).toThrow("local-source forks");
});

it("freezes a fork at the requested index even if the source advances", async () => {
  const gate = new Defer<void>();
  const { session, host, mockClient } = fixture(async (request, prepare) => {
    if (request.type === "fork") await gate.promise;
    return prepare();
  });
  host.contextOverrides = {
    resolve: async (message) =>
      sendResolved(
        [
          {
            type: "text",
            text: message,
          },
        ],
        [message],
      ),
  };
  const id = await created(session.createRootThread());
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
  host.options.autoCompactThreshold = 1;
  host.options.autoCompactPrompt = "changed policy";
  gate.resolve();
  const forkId = await created(forkCreation);
  const fork = session.getThread(forkId);
  if (fork?.state !== "initialized") throw new Error("expected fork");
  // The fork opens with the seam notice; everything before it is frozen.
  const forkMessages = fork.thread.getProviderMessages();
  expect(forkMessages.slice(0, -1)).toEqual(originalMessages);
  expect(forkMessages.at(-1)?.content).toEqual([
    expect.objectContaining({ type: "fork_notification" }),
  ]);
  expect([...fork.thread.activeReminders]).toEqual(["original reminder"]);
  expect(fork.thread.tokenBudget?.handoff).toBe("continue");
  expect(fork.thread.tokenBudget?.check(100_000)).toEqual({ type: "stop" });
});

it("aborts the subtree but returns only the requested thread's unsent input", async () => {
  const { session } = fixture();
  const root = await created(session.createRootThread());
  const child = await created(
    session.spawnThread({
      parentThreadId: root,
      prompt: "child work",
      threadType: "subagent",
    }),
  );
  const grandchild = await created(
    session.spawnThread({
      parentThreadId: child,
      prompt: "grandchild work",
      threadType: "subagent",
    }),
  );
  const threadOf = (id: ThreadId) => {
    const record = session.getThread(id);
    if (record?.state !== "initialized") throw new Error("expected thread");
    return record.thread;
  };
  void threadOf(root)
    .submit({ type: "raw", message: pendingMessage("root work") })
    .catch(() => {});
  // Queued behind the busy turn on both ends of the subtree.
  threadOf(root).enqueue(
    { type: "raw", message: pendingMessage("root leftover") },
    "next",
  );
  threadOf(grandchild).enqueue(
    { type: "raw", message: pendingMessage("deep leftover") },
    "next",
  );
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
  const release = vi.fn(async () => {});
  const { session } = fixture(withRelease(release));
  let destroy: ReturnType<typeof vi.spyOn> | undefined;
  session.on("changed", (id) => {
    const record = session.getThread(id);
    if (record?.state !== "initialized" || destroy) return;
    destroy = vi.spyOn(record.thread, "destroy");
    session.deleteThread(id);
  });
  await expect(session.createRootThread()).resolves.toBe(ABORTED);
  await session.dispose();
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(release).toHaveBeenCalledTimes(1);
});
it("refuses to reuse a thread id that is already registered", async () => {
  const { session, profile } = fixture();
  const id = uniqueThreadId("session-duplicate");
  await session.createThread({ threadId: id, ...rootOptions(profile) });
  await expect(
    session.createThread({ threadId: id, ...rootOptions(profile) }),
  ).rejects.toThrow("already exists");
  expect(session.listThreads().map((record) => record.id)).toEqual([id]);
});
it("records observed activity and ignores unknown ids", async () => {
  const { session } = fixture();
  const id = await created(session.createRootThread());
  const before = session.getThread(id)!.lastActivityTime;
  const changed: ThreadId[] = [];
  session.on("changed", (changedId) => changed.push(changedId));
  session.recordActivity("not-a-thread" as ThreadId);
  expect(changed).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 2));
  session.recordActivity(id);
  expect(session.getThread(id)!.lastActivityTime).toBeGreaterThan(before);
  expect(changed).toEqual([id]);
});
it("disposal settles streaming work once, drains cleanup and rejects new work", async () => {
  const { session, mockClient, profile } = fixture();
  const root = await created(session.createRootThread());
  const record = session.getThread(root);
  if (record?.state !== "initialized") throw new Error("expected root");
  const compactChild = await created(
    session.createThread({
      parent: root,
      profile: profile,
      threadType: "compact",
    }),
  );
  const submission = record.thread.submit({
    type: "raw",
    message: pendingMessage("stream something"),
  });
  const stream = await mockClient.awaitStream();
  stream.streamText("partial");
  const changed: ThreadId[] = [];
  session.on("changed", (id) => changed.push(id));
  const disposal = session.dispose();
  // The in-flight request is cancelled rather than left dangling.
  await disposal;
  expect(stream.aborted).toBe(true);
  await expect(submission).resolves.toBeDefined();
  expect(session.listThreads()).toEqual([]);
  // Retained results settle exactly once, for the subtree as well.
  await expect(session.awaitThreadResult(root)).resolves.toMatchObject({
    type: "aborted",
  });
  await expect(session.awaitThreadResult(compactChild)).resolves.toMatchObject({
    type: "aborted",
  });
  // Idempotent, listener-free, and closed to new work.
  await session.dispose();
  expect(changed).toEqual([]);
  await expect(session.createRootThread()).rejects.toThrow("disposed");
});
it("keeps two sessions' registries independent", async () => {
  const a = fixture();
  const b = fixture();
  const id = await created(a.session.createRootThread());
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
it("deleting a thread aborts its in-flight preparation handle", async () => {
  const { session, profile, host } = fixture();
  const preparation = new Defer<typeof ABORTED>();
  const abort = vi.fn(() => preparation.resolve(ABORTED));
  host.prepareThread = () => ({ promise: preparation.promise, abort });
  const id = uniqueThreadId("session-prepare-abort");
  const creation = session.createThread({
    threadId: id,
    ...rootOptions(profile),
  });
  session.deleteThread(id);
  expect(abort).toHaveBeenCalledTimes(1);
  expect(await creation).toBe(ABORTED);
});

it("aborts a preparation handle that arrives after its creation was deleted", async () => {
  const { session, profile, host } = fixture();
  const preparation = new Defer<typeof ABORTED>();
  const abort = vi.fn(() => preparation.resolve(ABORTED));
  const id = uniqueThreadId("session-prepare-late-handle");
  host.prepareThread = () => {
    session.deleteThread(id);
    return { promise: preparation.promise, abort };
  };
  const creation = session.createThread({
    threadId: id,
    ...rootOptions(profile),
  });
  expect(await creation).toBe(ABORTED);
  expect(abort).toHaveBeenCalledTimes(1);
});
