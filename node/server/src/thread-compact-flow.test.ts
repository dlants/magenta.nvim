import { expect, it } from "vitest";
import type { ScriptInvocationId, ThreadId } from "./chat-types.ts";
import {
  compactionRunThreadIds,
  type ThreadCompactor,
} from "./compaction/compactor.ts";
import type { MockStream } from "./providers/mock-anthropic-client.ts";
import { parseDelivery } from "./submission/index.ts";
import { type Harness, withHarness } from "./test/harness.ts";
import { created } from "./test-helpers.ts";
import type { Thread } from "./thread.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";
import { pollUntil } from "./utils/async.ts";

function compactorOf(h: Harness, id: ThreadId): ThreadCompactor {
  const record = h.session.getThread(id);
  if (record?.state !== "initialized" || !record.compactor)
    throw new Error("thread has no compactor");
  return record.compactor;
}
const isCompacting = (h: Harness, id: ThreadId) =>
  compactorOf(h, id).current !== undefined;
const finishedRuns = (h: Harness, id: ThreadId) =>
  compactorOf(h, id).runs.filter((run) => run.type !== "running");
const waitCompacting = (h: Harness, id: ThreadId) =>
  pollUntil(() => {
    if (!isCompacting(h, id)) throw new Error("expected compacting");
  });
const activeChunk = (h: Harness, id: ThreadId) => {
  const current = compactorOf(h, id).current;
  if (!current) throw new Error("not compacting");
  return current.activeThreadId;
};
const text = (stream: MockStream) =>
  stream
    .getProviderMessages()
    .flatMap((m) =>
      m.content.flatMap((c) =>
        c.type === "text" || c.type === "context_update" ? [c.text] : [],
      ),
    )
    .join("");

let seq = 0;
function writeSummary(stream: MockStream, summary: string) {
  seq += 1;
  stream.respond({
    stopReason: "tool_use",
    text: "Compacting.",
    toolRequests: [
      {
        status: "ok",
        value: {
          id: `edl_${seq}` as ToolRequestId,
          toolName: "edl" as ToolName,
          input: {
            script: `file \`/summary.md\`\nselect bof-eof\nreplace <<S\n# Summary\n${summary}\nS`,
          },
        },
      },
    ],
  });
}
function yieldChunk(stream: MockStream) {
  seq += 1;
  stream.respond({
    stopReason: "tool_use",
    text: "Summary written.",
    toolRequests: [
      {
        status: "ok",
        value: {
          id: `yield_${seq}` as ToolRequestId,
          toolName: "yield_to_parent" as ToolName,
          input: { result: "wrote /summary.md" },
        },
      },
    ],
  });
}
/** Drives the chunk thread whose stream is `stream` to a written summary. */
async function finishChunk(h: Harness, stream: MockStream, summary: string) {
  writeSummary(stream, summary);
  yieldChunk(await h.nextStream());
}
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
function type(thread: Thread, input: string) {
  const { delivery, message } = parseDelivery(input);
  if (delivery !== "now" && thread.isBusy) {
    thread.enqueue({ type: "raw", message }, delivery);
    return undefined;
  }
  return thread.submit({ type: "raw", message });
}
function initialized(h: Harness, id: ThreadId) {
  const record = h.session.getThread(id);
  if (record?.state !== "initialized") throw new Error("not initialized");
  return record;
}

it("does not seed a compact chunk thread with auto-context files", () =>
  withHarness(
    {
      files: { "/project/test-auto-context.md": "auto" },
      options: { autoContext: ["test-auto-context.md"] },
    },
    async (h) => {
      const { id, thread } = await h.createRoot();
      expect(Object.keys(thread.contextFiles.files)).toHaveLength(1);
      await exchange(h, thread, "What is 2+2?", "4.");
      void h.send(thread, "@compact");
      await h.nextStream();
      const chunkId = compactionRunThreadIds(compactorOf(h, id).current!)[0];
      expect(Object.keys(h.thread(chunkId).contextFiles.files)).toEqual([]);
    },
  ));

it("compact flow without continuation: @compact with no next prompt", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "Hello", "Hi there!");
    const done = h.send(thread, "@compact");
    await waitCompacting(h, id);
    const chunk = await h.nextStream();
    expect(chunk.params.model).toBe(h.host.profile.fastModel);
    await finishChunk(h, chunk, "Greeting conversation.");
    (await h.nextStream()).respond({
      stopReason: "end_turn",
      text: "Ready to continue!",
      toolRequests: [],
    });
    await done;
    expect(thread.state.type).toBe("idle");
    expect(thread.lastResult()).toMatchObject({
      type: "completed",
      stopReason: "end_turn",
    });
    expect(thread.getProviderMessages().length).toBeLessThanOrEqual(4);
    expect(JSON.stringify(thread.getProviderMessages())).toContain(
      "Greeting conversation.",
    );
  }));

it("lets the user rescue a chunk thread whose turn failed", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "Hello", "Hi there!");
    const done = h.send(thread, "@compact");
    await waitCompacting(h, id);
    (await h.nextStream()).respondWithError(
      new Error("compaction request blew up (non-retryable)"),
    );
    const chunk = h.thread(activeChunk(h, id));
    await pollUntil(() => {
      if (chunk.state.type !== "idle") throw new Error("waiting");
    });
    expect(isCompacting(h, id)).toBe(true);
    expect(finishedRuns(h, id)).toHaveLength(0);
    void h.send(chunk, "try again");
    await finishChunk(h, await h.nextStream(), "recovered");
    (await h.nextStream()).respond({
      stopReason: "end_turn",
      text: "Back on track.",
      toolRequests: [],
    });
    await done;
    const runs = finishedRuns(h, id);
    expect(runs).toHaveLength(1);
    expect(runs[0].type).toBe("done");
  }));

it("compact flow does not process @file commands in subagent or summary", () =>
  withHarness({ files: { "/project/poem.txt": "moonlight" } }, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(
      h,
      thread,
      "Tell me about poem.txt usage",
      "The @file:poem.txt command adds a file to context.",
    );
    const done = h.send(
      thread,
      "@compact Now read @file:poem.txt and summarize",
    );
    await waitCompacting(h, id);
    const chunk = await h.nextStream();
    const userMsg = chunk.getProviderMessages().find((m) => m.role === "user")!;
    const textBlocks = userMsg.content.filter((c) => c.type === "text");
    expect(textBlocks).toHaveLength(1);
    expect(JSON.stringify(textBlocks[0])).toContain("@file:poem.txt");
    await finishChunk(h, chunk, "User discussed @file:poem.txt usage.");
    const after = await h.nextStream();
    const users = after.getProviderMessages().filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    const blocks = users[0].content;
    const summaryIdx = blocks.findIndex(
      (b) => b.type === "text" && b.text.includes("<conversation-summary>"),
    );
    expect(summaryIdx).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(blocks[summaryIdx])).toContain("@file:poem.txt");
    expect(JSON.stringify(blocks.slice(summaryIdx + 1))).toContain(
      "Now read @file:poem.txt and summarize",
    );
    expect(Object.keys(thread.contextFiles.files)).toContain(
      "/project/poem.txt",
    );
    after.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
    await done;
  }));

it("forks a thread and compacts the fork in one step", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "What is 2+2?", "2+2 equals 4.");
    await exchange(h, thread, "What about 3+3?", "3+3 equals 6.");
    const forkId = await created(h.session.forkThread(id));
    const fork = h.thread(forkId);
    const done = h.send(fork, "@compact Now help me with multiplication");
    const chunk = await h.nextStream();
    expect(text(chunk)).toContain("2+2 equals 4");
    await finishChunk(h, chunk, "Arithmetic conversation.");
    const after = await h.nextStream();
    expect(text(after)).toContain("Now help me with multiplication");
    after.respond({ stopReason: "end_turn", text: "Sure!", toolRequests: [] });
    await done;
    expect(finishedRuns(h, forkId)).toHaveLength(1);
    expect(compactorOf(h, id).runs).toHaveLength(0);
    expect(JSON.stringify(thread.getProviderMessages())).toContain(
      "3+3 equals 6",
    );
  }));

it("auto-compact threshold from options wires into the thread's supervisor", () =>
  withHarness({ options: { autoCompactThreshold: 160_000 } }, async (h) => {
    h.mockClient.mockInputTokenCount = 100_000;
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "What is 2+2?", "2+2 equals 4.");
    expect(thread.tokenBudget).toBeDefined();
    expect(isCompacting(h, id)).toBe(false);
    h.mockClient.mockInputTokenCount = 170_000;
    void h.send(thread, "Another question");
    await waitCompacting(h, id);
  }));

it("auto-compact triggers when inputTokenCount breaches the supervisor threshold", () =>
  withHarness(
    {
      options: {
        autoCompactThreshold: 160_000,
        autoCompactPrompt: "Now help me with multiplication",
      },
    },
    async (h) => {
      h.mockClient.mockInputTokenCount = 100_000;
      const { id, thread } = await h.createRoot();
      await exchange(h, thread, "What is 2+2?", "2+2 equals 4.");
      h.mockClient.mockInputTokenCount = 170_000;
      const done = h.send(thread, "Another question");
      await waitCompacting(h, id);
      const chunk = await h.nextStream();
      expect(text(chunk)).toContain("2+2 equals 4");
      writeSummary(chunk, "User asked basic arithmetic");
      const afterEdl = await h.nextStream();
      h.mockClient.mockInputTokenCount = 1000;
      yieldChunk(afterEdl);
      const after = await h.nextStream();
      expect(text(after)).toContain("Now help me with multiplication");
      expect(text(after)).toContain("User asked basic arithmetic");
      after.respond({
        stopReason: "end_turn",
        text: "Sure!",
        toolRequests: [],
      });
      await done;
    },
  ));

/** Answers turns until the thread starts compacting; returns the chunk stream. */
async function driveUntilCompacting(
  h: Harness,
  id: ThreadId,
  next: () => void,
): Promise<MockStream> {
  for (let i = 0; i < 5; i++) {
    const stream = await h.nextStream();
    if (isCompacting(h, id)) return stream;
    stream.respond({
      stopReason: "end_turn",
      text: "working on it",
      toolRequests: [],
    });
    h.mockClient.mockInputTokenCount = 170_000;
    next();
  }
  throw new Error("thread did not auto-compact");
}

it("auto-compact uses the configured next prompt from options", () =>
  withHarness(
    {
      options: {
        autoCompactThreshold: 160_000,
        autoCompactPrompt: "CUSTOM_NEXT_PROMPT_XYZ do the follow-up work",
      },
    },
    async (h) => {
      h.mockClient.mockInputTokenCount = 1000;
      const { id, thread } = await h.createRoot();
      void h.send(thread, "What is 2+2?");
      const chunk = await driveUntilCompacting(h, id, () => {
        void h.send(thread, "And 3+3?");
      });
      expect(text(chunk)).toContain("CUSTOM_NEXT_PROMPT_XYZ");
    },
  ));

async function scriptThread(h: Harness, autoCompactPrompt?: string) {
  h.mockClient.mockInputTokenCount = 1000;
  const id = await created(
    h.session.spawnScriptThread({
      scriptInvocationId: `inv-${seq++}` as ScriptInvocationId,
      scriptName: "test-script",
      prompt: "do the work",
      yieldSchema: { type: "object", properties: {} },
      autoCompactThreshold: 160_000,
      ...(autoCompactPrompt ? { autoCompactPrompt } : {}),
    }),
  );
  const thread = h.thread(id);
  return driveUntilCompacting(h, id, () => {
    void thread.submit({
      type: "resolved",
      messages: [{ type: "text", text: "keep going" }],
    });
  });
}

it("script-spawned thread honors per-thread autoCompactPrompt override", () =>
  withHarness({}, async (h) => {
    const chunk = await scriptThread(
      h,
      "PER_THREAD_NEXT_PROMPT_QRS finish the migration",
    );
    expect(text(chunk)).toContain("PER_THREAD_NEXT_PROMPT_QRS");
  }));

it("script-spawned thread without prompt override falls back to the default template", () =>
  withHarness(
    { options: { autoCompactPrompt: "HOST_DEFAULT_PROMPT" } },
    async (h) => {
      const chunk = await scriptThread(h);
      expect(text(chunk)).not.toContain("PER_THREAD_NEXT_PROMPT_QRS");
      expect(text(chunk)).toContain("working brief");
      // The host's options default (nvim: `autoCompactPrompt`) applies.
      expect(text(chunk)).toContain("HOST_DEFAULT_PROMPT");
    },
  ));

it("auto-compact does not trigger on compact threads", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "Hello", "Hi there!");
    h.mockClient.mockInputTokenCount = 190_000;
    const done = h.send(thread, "@compact Continue please");
    await waitCompacting(h, id);
    const chunk = await h.nextStream();
    expect(initialized(h, activeChunk(h, id)).compactor).toBeUndefined();
    writeSummary(chunk, "Hello conversation");
    const afterEdl = await h.nextStream();
    h.mockClient.mockInputTokenCount = 1000;
    yieldChunk(afterEdl);
    (await h.nextStream()).respond({
      stopReason: "end_turn",
      text: "Continuing!",
      toolRequests: [],
    });
    await done;
    expect(finishedRuns(h, id).map((r) => r.type)).toEqual(["done"]);
  }));

it("compact keeps context files after compaction", () =>
  withHarness(
    {
      files: {
        "/project/context-file.ts": "export const x = 1;",
        "/project/poem.txt": "poem",
      },
    },
    async (h) => {
      const { thread } = await h.createRoot();
      await exchange(h, thread, "@file:context-file.ts Hello", "I see it.");
      expect(Object.keys(thread.contextFiles.files)).toHaveLength(1);
      const original = thread.contextFiles;
      const done = h.send(thread, "@compact Continue working");
      await finishChunk(h, await h.nextStream(), "context-file.ts hello");
      (await h.nextStream()).respond({
        stopReason: "end_turn",
        text: "Starting fresh!",
        toolRequests: [],
      });
      await done;
      expect(Object.keys(thread.contextFiles.files)).toEqual([
        "/project/context-file.ts",
      ]);
      expect(thread.contextFiles).not.toBe(original);
      const next = h.send(thread, "@file:poem.txt read");
      const stream = await h.nextStream();
      expect(JSON.stringify(stream.messages)).toContain("poem");
      stream.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
      await next;
      expect(Object.keys(thread.contextFiles.files)).toHaveLength(2);
    },
  ));

it("compaction keeps reminders derived from files still tracked in context", () =>
  withHarness(
    {
      files: {
        "/project/ctx.md":
          "# Ctx\n\n<system_reminder>\ncontext cat reminder\n</system_reminder>\n",
        "/project/transient.md":
          "# Transient\n\n<system_reminder>\ntransient cat reminder\n</system_reminder>\n",
      },
    },
    async (h) => {
      const { thread } = await h.createRoot();
      const first = h.send(thread, "@file:ctx.md Use a skill");
      (await h.nextStream()).respond({
        stopReason: "tool_use",
        text: "reading the transient skill",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "tool_1" as ToolRequestId,
              toolName: "get_files" as ToolName,
              input: { files: [{ filePath: "./transient.md" }] },
            },
          },
        ],
        usage: { inputTokens: 100, outputTokens: 5000 },
      });
      (await h.nextStream()).respond({
        stopReason: "end_turn",
        text: "done reading",
        toolRequests: [],
      });
      await first;
      const done = h.send(thread, "@compact continue please");
      const chunk = await h.nextStream();
      expect(JSON.stringify(chunk.messages)).not.toContain("<system-reminder>");
      await finishChunk(h, chunk, "read skills");
      (await h.nextStream()).respond({
        stopReason: "end_turn",
        text: "all set",
        toolRequests: [],
        usage: { inputTokens: 100, outputTokens: 5000 },
      });
      await done;
      void h.send(thread, "carry on");
      const next = await h.nextStream();
      const last = next.messages[next.messages.length - 1];
      if (typeof last.content === "string") throw new Error("expected array");
      const reminder = last.content.find(
        (c) => c.type === "text" && c.text.includes("<system-reminder>"),
      );
      expect(JSON.stringify(reminder)).toContain("context cat reminder");
      expect(JSON.stringify(reminder)).toContain("transient cat reminder");
    },
  ));

it("deleting the compact child thread aborts the parked submission", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "Hello", "Hi there!");
    void h.send(thread, "@compact").catch(() => undefined);
    await waitCompacting(h, id);
    h.session.deleteThread(activeChunk(h, id));
    await pollUntil(() => {
      expect(finishedRuns(h, id).map((r) => r.type)).toEqual(["aborted"]);
    });
    expect(isCompacting(h, id)).toBe(false);
    await pollUntil(() => expect(thread.state.type).toBe("idle"));
  }));

it("fails the parked submission when the chunk thread yields an empty summary", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "Hello", "Hi there!");
    void h.send(thread, "@compact").catch(() => undefined);
    yieldChunk(await h.nextStream());
    await pollUntil(() => {
      expect(finishedRuns(h, id).map((r) => r.type)).toEqual(["error"]);
    });
    expect(JSON.stringify(finishedRuns(h, id)[0])).toContain(
      "the compaction finished but /summary.md is empty",
    );
    expect(isCompacting(h, id)).toBe(false);
    await pollUntil(() => expect(thread.state.type).toBe("idle"));
  }));

it("discards an in-flight run when a fresh @compact arrives", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "Hello", "Hi there!");
    void h.send(thread, "@compact").catch(() => undefined);
    await waitCompacting(h, id);
    const firstChunk = activeChunk(h, id);
    void h.send(thread, "@compact").catch(() => undefined);
    await pollUntil(() => {
      expect(finishedRuns(h, id).map((r) => r.type)).toEqual(["aborted"]);
      expect(isCompacting(h, id)).toBe(true);
      expect(activeChunk(h, id)).not.toBe(firstChunk);
    });
    expect(h.session.getThread(firstChunk)).toBeUndefined();
  }));

it("delivers @compact typed into a compact thread as ordinary text", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "Hello", "Hi there!");
    void h.send(thread, "@compact").catch(() => undefined);
    (await h.nextStream()).respondWithError(
      new Error("stall the chunk thread"),
    );
    const chunkId = activeChunk(h, id);
    const chunk = h.thread(chunkId);
    await pollUntil(() => expect(chunk.state.type).toBe("idle"));
    void h.send(chunk, "@compact foo");
    expect(text(await h.nextStream())).toContain("@compact foo");
    expect(initialized(h, chunkId).compactor).toBeUndefined();
  }));

it("defers a @next @compact until the turn in flight comes to rest", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    void h.send(thread, "What is 2+2?");
    const inFlight = await h.nextStream();
    type(thread, "@next @compact Now do multiplication");
    expect(thread.queued.next).toHaveLength(1);
    expect(isCompacting(h, id)).toBe(false);
    inFlight.respond({
      stopReason: "end_turn",
      text: "2+2 equals 4.",
      toolRequests: [],
    });
    await waitCompacting(h, id);
    expect(text(await h.nextStream())).toContain("Now do multiplication");
  }));
