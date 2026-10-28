import { afterEach, expect, it, vi } from "vitest";
import type {
  ContentBlockIdx,
  DisplayBufferText,
  MessageIdx,
  ThreadId,
} from "./chat-types.ts";
import type { ProviderProfile } from "./provider-options.ts";
import type { NativeMessageIdx } from "./providers/provider-types.ts";
import { REFLECT_SYSTEM_PROMPT } from "./providers/system-prompt.ts";
import type { SessionCreateOptions } from "./session.ts";
import { pendingMessage, renderPending } from "./submission/index.ts";
import { FakeClient } from "./test/fakes.ts";
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
  UnsupervisedSupervisor,
} from "./thread-supervisor.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";
import { Defer } from "./utils/async.ts";
import { type AbsFilePath, toProjectDir } from "./utils/files.ts";

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

it("records fork origins on the server", async () => {
  const { session } = fixture();
  const id = await created(session.createRootThread());
  const record = session.getThread(id);
  if (record?.state !== "initialized") throw new Error("expected initialized");
  const idx = record.thread.nativeMessageIdx;
  const forkId = await created(session.forkThread(id, idx));
  expect(session.getOrigin(forkId)).toEqual({
    type: "fork",
    sourceThreadId: id,
    nativeMessageIdx: idx,
  });
  expect(session.getOrigin(id)).toBeUndefined();
  expect(session.listDerived(id, "fork").map((d) => d.threadId)).toEqual([
    forkId,
  ]);
  expect(session.listDerived(forkId, "fork")).toEqual([]);

  const secondForkId = await created(
    session.forkThread(id, 0 as NativeMessageIdx),
  );
  const grandchildId = await created(session.forkThread(forkId, idx));
  expect(session.listDerived(id, "fork").map((d) => d.threadId)).toEqual([
    forkId,
    secondForkId,
  ]);
  expect(session.listDerived(forkId, "fork").map((d) => d.threadId)).toEqual([
    grandchildId,
  ]);
  expect(session.getOrigin(grandchildId)?.sourceThreadId).toBe(forkId);
});

it("derives a child's profile and environment from the parent record", async () => {
  const { session, host, profile } = fixture();
  host.contextOverrides = {
    environmentConfig: {
      type: "docker",
      container: "remote",
      projectDir: toProjectDir("/work"),
    },
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
  expect(session.getOrigin(childId)).toBeUndefined();
  expect(session.listDerived(parentId, "fork")).toEqual([]);
  expect(child.parentThreadId).toBe(parentId);
  // The fast-model child inherits the parent's profile with the fast model.
  expect(child.options.profile.model).toBe("fast-model");
  // Environment is inherited from what the parent's construction resolved.
  expect(child.options.environmentConfig).toEqual({
    type: "docker",
    container: "remote",
    projectDir: "/work",
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
  ).toEqual([MaxTokensSupervisor, UnsupervisedSupervisor, TitleSupervisor]);
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
  const { session } = fixture(withRelease(release));
  const id = await created(session.createRootThread());
  const record = session.getThread(id);
  if (record?.state !== "initialized") throw new Error("expected initialized");
  const destroy = record.thread.destroy.bind(record.thread);
  vi.spyOn(record.thread, "destroy").mockImplementation(async () => {
    await destroy();
    throw new Error("teardown failed");
  });
  const approval = session
    .approvalsFor(id)
    .promptForWriteApproval("/x" as AbsFilePath);
  expect(session.getPendingApprovals(id).size).toBe(1);
  session.deleteThread(id);
  await expect(approval).rejects.toThrow("did not allow writing");
  await session.dispose();
  expect(session.getPendingApprovals(id).size).toBe(0);
  expect(release).toHaveBeenCalledTimes(1);
});

it("uses the prepared environment when checking whether a fork is local", async () => {
  const { session, profile, host } = fixture();
  host.contextOverrides = {
    environmentConfig: {
      type: "docker",
      container: "remote",
      projectDir: toProjectDir("/workspace"),
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
  const approval = session
    .approvalsFor(grandchild)
    .promptForWriteApproval("/x" as AbsFilePath);
  const { unsent } = await session.abortThread(root);
  await expect(approval).rejects.toThrow("did not allow writing");
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

it("creates a reflect thread seeded from the source without sending", async () => {
  const { session, mockClient } = fixture();
  const id = await created(session.createRootThread());
  const record = session.getThread(id);
  if (record?.state !== "initialized") throw new Error("expected source");
  const first = record.thread.submit({
    type: "resolved",
    messages: [{ type: "text", text: "please explain recursion" }],
  });
  const stream = await mockClient.awaitStream();
  stream.streamText("recursion is when a function calls itself");
  stream.finishResponse("end_turn");
  await first;
  const streamsBefore = mockClient.streams.length;
  const anchor = {
    messageIdx: 1 as MessageIdx,
    contentIdx: 0 as ContentBlockIdx,
    reflectionText: "calls itself" as DisplayBufferText,
  };
  const reflectId = await created(session.reflectThread(id, anchor));
  expect(session.getOrigin(reflectId)).toEqual({
    type: "reflect",
    sourceThreadId: id,
    anchor,
  });
  expect(session.listDerived(id, "reflect").map((d) => d.threadId)).toEqual([
    reflectId,
  ]);
  expect(session.isSandboxBypassed(reflectId)).toBe(false);
  session.toggleSandboxBypass(id);
  expect(session.isSandboxBypassed(reflectId)).toBe(true);
  session.toggleSandboxBypass(reflectId);
  expect(session.isSandboxBypassed(id)).toBe(false);
  const reflect = session.getThread(reflectId);
  if (reflect?.state !== "initialized") throw new Error("expected reflect");
  expect(mockClient.streams.length).toBe(streamsBefore);
  const seeded = reflect.thread.getProviderMessages();
  expect(seeded).toHaveLength(1);
  expect(seeded[0].role).toBe("user");
  expect(seeded[0].content.map((c) => c.type)).toEqual([
    "thread_context",
    "text",
  ]);
  expect(reflect.thread.threadType).toBe("reflect");
  const toolNames = reflect.thread.toolSpecs.map((s) => s.name);
  for (const tool of ["get_files", "bash_command", "edl"]) {
    expect(toolNames).toContain(tool);
  }
  for (const excluded of ["yield_to_parent", "spawn_subagents", "nvim_lua"]) {
    expect(toolNames).not.toContain(excluded);
  }

  const answer = reflect.thread.submit({
    type: "resolved",
    messages: [{ type: "text", text: "why?" }],
  });
  const reflectStream = await awaitNextStream(mockClient, stream);
  expect(reflectStream.systemPrompt).toContain(REFLECT_SYSTEM_PROMPT);
  const userMessages = reflectStream.messages.filter((m) => m.role === "user");
  expect(userMessages).toHaveLength(1);
  const texts = (
    userMessages[0].content as Array<{ type: string; text?: string }>
  )
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "");
  const contextIdx = texts.findIndex((t) => t.startsWith("<thread-context>"));
  const selectionIdx = texts.findIndex((t) =>
    t.startsWith("The user selected:"),
  );
  const questionIdx = texts.indexOf("why?");
  expect(contextIdx).toBeGreaterThanOrEqual(0);
  expect(selectionIdx).toBeGreaterThan(contextIdx);
  expect(questionIdx).toBeGreaterThan(selectionIdx);
  expect(texts[contextIdx]).toContain("please explain recursion");
  expect(texts[selectionIdx]).toBe("The user selected:\n> calls itself");
  reflectStream.streamText("because");
  reflectStream.finishResponse("end_turn");
  await answer;
  expect(reflect.thread.getProviderMessages()[0].content[0].type).toBe(
    "thread_context",
  );

  session.deleteThread(id);
  expect(session.getThread(reflectId)).toBeUndefined();
});

it("rejects reflecting on a missing message or an unavailable source", async () => {
  const { session } = fixture();
  const id = await created(session.createRootThread());
  const anchorAt = (messageIdx: number) => ({
    messageIdx: messageIdx as MessageIdx,
    contentIdx: 0 as ContentBlockIdx,
    reflectionText: "x" as DisplayBufferText,
  });
  expect(() => session.reflectThread(id, anchorAt(-1))).toThrow();
  expect(() => session.reflectThread(id, anchorAt(0))).toThrow();
  const pending = session.createRootThread();
  const pendingId = session
    .listThreads()
    .find((t) => t.state !== "initialized")?.id;
  if (!pendingId) throw new Error("expected a pending thread");
  expect(() => session.reflectThread(pendingId, anchorAt(0))).toThrow();
  await pending;
  session.deleteThread(id);
  expect(() => session.reflectThread(id, anchorAt(0))).toThrow();
});

it("only creates reflect threads through reflectThread", () => {
  const { session } = fixture();
  const options: SessionCreateOptions = {
    profile: {} as ProviderProfile,
    // @ts-expect-error reflect threads need a seed and an origin
    threadType: "reflect",
  };
  expect(options.threadType).toBe("reflect");
  expect(session).toBeDefined();
});

it("deletes nested and pending reflections with their source", async () => {
  const { session, mockClient } = fixture();
  const id = await created(session.createRootThread());
  const record = session.getThread(id);
  if (record?.state !== "initialized") throw new Error("expected source");
  const first = record.thread.submit({
    type: "resolved",
    messages: [{ type: "text", text: "hi" }],
  });
  const stream = await mockClient.awaitStream();
  stream.streamText("hello");
  stream.finishResponse("end_turn");
  await first;
  const anchor = {
    messageIdx: 1 as MessageIdx,
    contentIdx: 0 as ContentBlockIdx,
    reflectionText: "hello" as DisplayBufferText,
  };
  const reflectId = await created(session.reflectThread(id, anchor));
  const nestedId = await created(
    session.reflectThread(reflectId, {
      ...anchor,
      messageIdx: 0 as MessageIdx,
      reflectionText: "[thread context]" as DisplayBufferText,
    }),
  );
  const pendingCreation = session.reflectThread(id, anchor);
  expect(session.listDerived(id, "reflect")).toHaveLength(2);
  session.deleteThread(id);
  expect(session.getThread(reflectId)).toBeUndefined();
  expect(session.getThread(nestedId)).toBeUndefined();
  expect(session.listDerived(id, "reflect")).toEqual([]);
  await pendingCreation;
  expect(session.listThreads()).toEqual([]);
});
it("owns approvals and bypass: toggling a root approves its subtree, forks inherit", async () => {
  const { session } = fixture();
  const rootId = await created(session.createRootThread());
  const childId = await created(
    session.spawnThread({
      parentThreadId: rootId,
      prompt: "do work",
      threadType: "subagent",
    }),
  );
  const write = session
    .approvalsFor(childId)
    .promptForWriteApproval("/x" as AbsFilePath);
  expect([...session.getPendingApprovals(childId).values()]).toMatchObject([
    { prompt: { kind: "write-approval", absPath: "/x" } },
  ]);
  expect(session.isSandboxBypassed(childId)).toBe(false);
  session.toggleSandboxBypass(childId);
  await expect(write).resolves.toBeUndefined();
  expect(session.getPendingApprovals(childId).size).toBe(0);
  expect(session.isSandboxBypassed(rootId)).toBe(true);
  expect(session.isSandboxBypassed(childId)).toBe(true);
  const forkId = await created(session.forkThread(rootId));
  expect(session.isSandboxBypassed(forkId)).toBe(true);
  session.toggleSandboxBypass(rootId);
  expect(session.isSandboxBypassed(rootId)).toBe(false);
  expect(session.isSandboxBypassed(forkId)).toBe(true);
});

it("delegates bypass of an externally owned root to that root", async () => {
  const { session } = fixture();
  const rootId = await created(session.createRootThread());
  const childId = await created(
    session.spawnThread({
      parentThreadId: rootId,
      prompt: "do work",
      threadType: "subagent",
    }),
  );
  let externalBypassed = false;
  const toggle = vi.fn(() => {
    externalBypassed = !externalBypassed;
  });
  session.registerSandboxRoot(rootId, () => ({
    get isSandboxBypassed() {
      return externalBypassed;
    },
    toggle,
  }));
  const write = session
    .approvalsFor(childId)
    .promptForWriteApproval("/x" as AbsFilePath);
  session.toggleSandboxBypass(childId);
  expect(toggle).toHaveBeenCalledTimes(1);
  await expect(write).resolves.toBeUndefined();
  expect(session.isSandboxBypassed(childId)).toBe(true);
  // The session's own bypass set was untouched: once the external root
  // reports not bypassed, neither is the tree.
  externalBypassed = false;
  expect(session.isSandboxBypassed(rootId)).toBe(false);
});
it("awaitClient resolves on attach, supports abort, and rejects on dispose", async () => {
  const { session } = fixture();
  const client = new FakeClient();
  const waiting = session.awaitClient();
  const aborted = session.awaitClient();
  expect(session.awaitingClient).toBe(2);
  aborted.abort();
  aborted.abort();
  expect(await aborted.promise).toBe(ABORTED);
  expect(session.awaitingClient).toBe(1);
  session.attachClient(client);
  expect(await waiting.promise).toBe(client);
  waiting.abort();
  expect(session.awaitingClient).toBe(0);
  expect(await session.awaitClient().promise).toBe(client);
  session.detachClient();
  const pending = session.awaitClient();
  await session.dispose();
  await expect(pending.promise).rejects.toThrow("Session disposed");
  await expect(session.awaitClient().promise).rejects.toThrow(
    "Session disposed",
  );
  expect(session.awaitingClient).toBe(0);
});
