// biome-ignore-all lint/complexity/useLiteralKeys: White-box fork wiring checks read private context.
import { expect, it, vi } from "vitest";
import type { MockStream } from "./providers/mock-anthropic-client.ts";
import type { NativeMessageIdx } from "./providers/provider-types.ts";
import { type Harness, withHarness } from "./test/harness.ts";
import { created } from "./test-helpers.ts";
import type { Thread } from "./thread.ts";
import { TitleSupervisor } from "./thread-assembly.ts";
import { MaxTokensSupervisor } from "./thread-supervisor.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";

async function exchange(
  h: Harness,
  thread: Thread,
  msg: string,
  reply: string,
) {
  const done = h.send(thread, msg);
  (await h.nextStream()).respond({
    stopReason: "end_turn",
    text: reply,
    toolRequests: [],
  });
  await done;
}
const lastUserHasContextUpdate = (stream: MockStream) =>
  [...stream.getProviderMessages()]
    .reverse()
    .find((m) => m.role === "user")
    ?.content.some((c) => c.type === "context_update");
const files = { "/project/poem.txt": "moonlight\nover the sea\n" };

it("no <context_update> on first turn after fork when files unchanged", () =>
  withHarness({ files }, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "Read @file:poem.txt", "I read the poem.");
    const fork = h.thread(
      await created(h.session.forkThread(id, thread.nativeMessageIdx)),
    );
    void h.send(fork, "Continue the conversation");
    expect(lastUserHasContextUpdate(await h.nextStream())).toBe(false);
  }));

it("<context_update> IS sent if a tracked file changes after fork", () =>
  withHarness({ files }, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "Read @file:poem.txt", "I read the poem.");
    const fork = h.thread(
      await created(h.session.forkThread(id, thread.nativeMessageIdx)),
    );
    await h.fileIO.writeFile("/project/poem.txt", "completely different\n");
    void h.send(fork, "Continue the conversation");
    expect(lastUserHasContextUpdate(await h.nextStream())).toBe(true);
  }));

it("truncated fork reseeds context delivered only after the fork point", () =>
  withHarness({ files }, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "Start without file context", "Ready.");
    const forkPoint = thread.nativeMessageIdx;
    await exchange(h, thread, "Now read @file:poem.txt", "Read it.");
    expect(thread.nativeMessageIdx).toBeGreaterThan(forkPoint);
    const fork = h.thread(await created(h.session.forkThread(id, forkPoint)));
    void h.send(fork, "Continue from the earlier point");
    expect(lastUserHasContextUpdate(await h.nextStream())).toBe(true);
  }));

it("tool result map survives the fork", () =>
  withHarness({ files }, async (h) => {
    const { id, thread } = await h.createRoot();
    const done = h.send(thread, "Read poem.txt");
    (await h.nextStream()).respond({
      stopReason: "tool_use",
      text: "Reading poem.txt",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "get-file-1" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: { files: [{ filePath: "./poem.txt" }] },
          },
        },
      ],
    });
    (await h.nextStream()).respond({
      stopReason: "end_turn",
      text: "Done reading.",
      toolRequests: [],
    });
    await done;
    const fork = h.thread(
      await created(h.session.forkThread(id, thread.nativeMessageIdx)),
    );
    expect(fork.completedTools.has("get-file-1" as ToolRequestId)).toBe(true);
  }));

it("source agent is unaffected by clone", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "hello", "hi");
    await exchange(h, thread, "again", "hi again");
    const messagesBefore = thread.getProviderMessages().length;
    const statusBefore = thread.state.type;
    const resultBefore = thread.lastResult();
    await created(
      h.session.forkThread(
        id,
        (thread.nativeMessageIdx - 1) as NativeMessageIdx,
      ),
    );
    expect(thread.getProviderMessages()).toHaveLength(messagesBefore);
    expect(thread.state.type).toBe(statusBefore);
    expect(thread.lastResult()).toEqual(resultBefore);
  }));

it("fork appends an id-free fork_notification merged with the next message", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "hello", "hi");
    const fork = h.thread(
      await created(h.session.forkThread(id, thread.nativeMessageIdx)),
    );
    await exchange(h, fork, "continue", "sure");
    const messages = fork.getProviderMessages();
    const markerIdx = messages.findIndex((m) =>
      m.content.some((c) => c.type === "fork_notification"),
    );
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(messages[markerIdx])).not.toContain(id);
    expect(JSON.stringify(messages[markerIdx])).toContain("continue");
    expect(
      messages.some(
        (m, i) => i > 0 && m.role === "user" && messages[i - 1].role === "user",
      ),
    ).toBe(false);
    expect(
      thread
        .getProviderMessages()
        .some((m) => m.content.some((c) => c.type === "fork_notification")),
    ).toBe(false);
  }));

it("agent clone happens exactly once", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "hello", "hi");
    const cloneSpy = vi.spyOn(thread["core"].manager, "clone");
    await created(h.session.forkThread(id, thread.nativeMessageIdx));
    expect(cloneSpy).toHaveBeenCalledTimes(1);
  }));

it("fresh and forked threads resolve their first command with equivalent execution wiring", () =>
  withHarness({ files }, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "Read @file:poem.txt", "Ready to fork");
    expect(Object.keys(thread.contextFiles.files)).toContain(
      "/project/poem.txt",
    );
    const forkId = await created(
      h.session.forkThread(id, thread.nativeMessageIdx),
    );
    const fork = h.thread(forkId);
    expect(fork.toolSpecs).toEqual(thread.toolSpecs);
    expect(fork["context"].getScriptRunner?.()).toBe(
      thread["context"].getScriptRunner?.(),
    );
    expect(fork.submissionSupervisors.map((p) => p.constructor)).toEqual([
      MaxTokensSupervisor,
      TitleSupervisor,
    ]);
    expect(fork["context"].resolve).not.toBe(thread["context"].resolve);
    const record = h.session.getThread(forkId);
    const source = h.session.getThread(id);
    if (record?.state !== "initialized" || source?.state !== "initialized")
      throw new Error("expected initialized");
    expect(record.compactor).toBe(fork["context"].compaction?.compactor);
    expect(record.compactor).not.toBe(source.compactor);
    await h.fileIO.writeFile("/project/fork-only.txt", "fork command content");
    void h.send(fork, "Read @file:fork-only.txt again");
    expect(JSON.stringify((await h.nextStream()).messages)).toContain(
      "fork command content",
    );
    expect(Object.keys(fork.contextFiles.files)).toContain(
      "/project/fork-only.txt",
    );
    expect(Object.keys(thread.contextFiles.files)).not.toContain(
      "/project/fork-only.txt",
    );
  }));
