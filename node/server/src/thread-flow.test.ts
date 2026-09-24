import type Anthropic from "@anthropic-ai/sdk";
import { expect, it } from "vitest";
import { loopLabel } from "./loop-state.ts";
import type { MockStream } from "./providers/mock-anthropic-client.ts";
import { parseDelivery, renderPending } from "./submission/index.ts";
import { shellResult } from "./test/fakes.ts";
import { type Harness, withHarness } from "./test/harness.ts";
import type { Thread } from "./thread.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";
import { pollUntil } from "./utils/async.ts";

/** Mirrors the nvim input path: deferred input rides the in-flight request,
 * or goes out now when nothing is in flight. */
function type(thread: Thread, text: string): Promise<unknown> | undefined {
  const { delivery, message } = parseDelivery(text);
  if (delivery !== "now" && thread.isBusy) {
    thread.enqueue({ type: "raw", message }, delivery);
    return undefined;
  }
  return thread.submit({ type: "raw", message });
}

const wirePattern = (messages: Anthropic.MessageParam[]) =>
  messages.flatMap((m) =>
    typeof m.content === "string"
      ? ["stringmessage"]
      : m.content.map((c) => `${m.role}:${c.type}`),
  );
const displayPattern = (thread: Thread) =>
  thread
    .getProviderMessages()
    .flatMap((m) => m.content.map((b) => `${m.role}:${b.type}`));
const hasText = (stream: MockStream, text: string) =>
  JSON.stringify(stream.messages).includes(text);

function bashRequest(id: string, command: string) {
  return {
    status: "ok" as const,
    value: {
      id: id as ToolRequestId,
      toolName: "bash_command" as ToolName,
      input: { command },
    },
  };
}
async function pendingShell(h: Harness) {
  return pollUntil(() => {
    const entry = h.shell.pending[0];
    if (!entry) throw new Error("waiting for shell");
    return entry;
  });
}
async function exchange(
  h: Harness,
  thread: Thread,
  text: string,
  reply: string,
) {
  const done = h.send(thread, text);
  const stream = await h.nextStream();
  stream.respond({ stopReason: "end_turn", text: reply, toolRequests: [] });
  await done;
}

it("getMessages correctly interleaves tool requests and responses", () =>
  withHarness(
    {
      shell: {
        "echo 'Project files summary'": { stdout: "Project files summary" },
        "echo 'Project structure summary'": {
          stdout: "Project structure summary",
        },
      },
    },
    async (h) => {
      const { thread } = await h.createRoot();
      const done = h.send(thread, "Can you help me with my code?");
      (await h.nextStream()).respond({
        stopReason: "tool_use",
        text: "I'll help you. Let me check your project first.",
        toolRequests: [bashRequest("tool-1", "echo 'Project files summary'")],
      });
      (await h.nextStream()).respond({
        stopReason: "tool_use",
        text: "Now let me check your project structure.",
        toolRequests: [
          bashRequest("tool-2", "echo 'Project structure summary'"),
        ],
      });
      (await h.nextStream()).respond({
        stopReason: "end_turn",
        text: "Based on these results, I can help you.",
        toolRequests: [],
      });
      await done;
      // 6, not 8: the continuation's reminder is coalesced into the same user
      // message as the tool result it rides with.
      expect(thread.getProviderMessages()).toHaveLength(6);
      expect(displayPattern(thread)).toEqual([
        "user:system_info",
        "user:system_reminder",
        "user:text",
        "assistant:text",
        "assistant:tool_use",
        "user:tool_result",
        "user:system_reminder",
        "assistant:text",
        "assistant:tool_use",
        "user:tool_result",
        "user:system_reminder",
        "assistant:text",
      ]);
      expect(JSON.stringify(thread.getProviderMessages())).toContain(
        "Project structure summary",
      );
    },
  ));

it("keeps queued messages pending when a submission fails", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    const done = h.send(thread, "Original message");
    const stream = await h.nextStream();
    type(thread, "@async Queued pending message");
    expect(thread.queued.async).toHaveLength(1);
    stream.respondWithError(new Error("Simulated error with pending messages"));
    await done.catch(() => undefined);
    // The queued message was never delivered, so it stays queued.
    expect(thread.queued.async).toHaveLength(1);
    expect(renderPending(thread.queued.async[0])).toBe(
      "Queued pending message",
    );
  }));

it("keeps the partial turn when the error arrives after assistant content", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    const done = h.send(thread, "Original message");
    const stream = await h.nextStream();
    stream.streamText("Partial assistant response");
    await pollUntil(() =>
      expect(JSON.stringify(thread.getProviderMessages())).toContain(
        "Partial assistant response",
      ),
    );
    stream.respondWithError(new Error("Simulated mid-stream error"));
    await done.catch(() => undefined);
    // The half-streamed turn is repaired, not discarded: a retry reissues the
    // request against exactly this log.
    expect(thread.getProviderMessages().map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    void thread.retry();
    const retry = await h.nextStream();
    expect(retry.messages.filter((m) => m.role === "user")).toHaveLength(1);
  }));

it("forks a thread with multiple messages into a new thread", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(
      h,
      thread,
      "What is the capital of France?",
      "The capital of France is Paris.",
    );
    const forkPoint = thread.nativeMessageIdx;
    await exchange(
      h,
      thread,
      "What about Germany?",
      "The capital of Germany is Berlin.",
    );
    const fork = h.thread(await h.session.forkThread(id, forkPoint));
    const done = h.send(fork, "Tell me about Italy");
    const stream = await h.nextStream();
    expect(hasText(stream, "The capital of France is Paris.")).toBe(true);
    expect(hasText(stream, "Germany")).toBe(false);
    expect(hasText(stream, "Tell me about Italy")).toBe(true);
    stream.respond({
      stopReason: "end_turn",
      text: "Italy's capital is Rome.",
      toolRequests: [],
    });
    await done;
    const texts = JSON.stringify(fork.getProviderMessages());
    expect(texts).toContain("The capital of France is Paris.");
    expect(texts).toContain("Italy's capital is Rome.");
    expect(texts).not.toContain("Berlin");
    expect(JSON.stringify(thread.getProviderMessages())).not.toContain("Italy");
  }));

it("handles @file commands", () =>
  withHarness(
    {
      files: {
        "/project/poem.txt": "moonlight poem",
        "/project/poem2.txt": "sunshine poem",
      },
    },
    async (h) => {
      const { thread } = await h.createRoot();
      void h.send(
        thread,
        "Compare these files @file:poem.txt and @file:poem2.txt",
      );
      const stream = await h.nextStream();
      expect(hasText(stream, "moonlight poem")).toBe(true);
      expect(hasText(stream, "sunshine poem")).toBe(true);
      expect(Object.keys(thread.contextFiles.files).sort()).toEqual([
        "/project/poem.txt",
        "/project/poem2.txt",
      ]);
    },
  ));

it("handles thinking and redacted thinking blocks", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    const done = h.send(thread, "Designing a schema?");
    const stream = await h.nextStream();
    stream.streamThinking("abc\ndef\nghi");
    stream.streamRedactedThinking("redacted-data");
    // Anthropic rejects messages ending in thinking, so real responses always
    // follow thinking with text/tool_use.
    stream.streamText("Here are some considerations.");
    stream.finishResponse("end_turn");
    await done;
    const assistant = thread.getProviderMessages().at(-1);
    expect(assistant?.content.map((b) => b.type)).toEqual([
      "thinking",
      "redacted_thinking",
      "text",
    ]);

    void h.send(thread, "Can you elaborate on normalization?");
    const followup = await h.nextStream();
    const content = followup.messages.find(
      (m) => m.role === "assistant",
    )?.content;
    if (!Array.isArray(content)) throw new Error("Expected array");
    expect(content).toHaveLength(3);
    expect(content[0]).toMatchObject({
      type: "thinking",
      thinking: "abc\ndef\nghi",
    });
    expect(content[1]).toMatchObject({
      type: "redacted_thinking",
      data: "redacted-data",
    });
  }));

it("handles @async messages by queueing them and sending on next tool response", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "Can you run a command?");
    (await h.nextStream()).respond({
      stopReason: "tool_use",
      text: "I'll run the command.",
      toolRequests: [bashRequest("bash-tool", "cat .secret")],
    });
    const call = await pendingShell(h);
    type(thread, "@async This should be queued");
    expect(thread.queued.async).toHaveLength(1);
    call.result.resolve(shellResult({ stdout: "secret" }));
    const stream2 = await h.nextStream();
    expect(wirePattern(stream2.messages)).toEqual([
      "user:text",
      "user:text", // system_info
      "user:text", // opening system_reminder
      "assistant:text",
      "assistant:tool_use",
      "user:tool_result",
      "user:text",
      "user:text", // system_reminder
    ]);
    expect(hasText(stream2, "This should be queued")).toBe(true);
    expect(thread.queued.async).toHaveLength(0);
  }));

it("handles @async messages and sends them on end turn", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "Tell me about TypeScript");
    const request1 = await h.nextStream();
    type(thread, "@async Also tell me about JavaScript");
    expect(thread.queued.async).toHaveLength(1);
    expect(renderPending(thread.queued.async[0])).toBe(
      "Also tell me about JavaScript",
    );
    request1.respond({
      stopReason: "end_turn",
      text: "TypeScript is a typed superset of JavaScript.",
      toolRequests: [],
    });
    const request2 = await h.nextStream();
    expect(hasText(request2, "Also tell me about JavaScript")).toBe(true);
    expect(hasText(request2, "TypeScript is a typed superset")).toBe(true);
    expect(thread.queued.async).toHaveLength(0);
  }));

it("sends an @async message right away when the thread is at rest", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    type(thread, "@async Tell me about TypeScript");
    const request = await h.nextStream();
    expect(thread.queued.async).toHaveLength(0);
    expect(hasText(request, "Tell me about TypeScript")).toBe(true);
    expect(hasText(request, "@async")).toBe(false);
  }));

it("queues @next messages until the agent next stops", () =>
  withHarness({ files: { "/project/poem.txt": "a poem" } }, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "Read a file for me");
    const request1 = await h.nextStream();
    type(thread, "@next Then summarize it");
    expect(thread.queued.next).toHaveLength(1);
    expect(renderPending(thread.queued.next[0])).toBe("Then summarize it");
    expect(thread.queued.async).toHaveLength(0);
    request1.respond({
      stopReason: "tool_use",
      text: "I'll read the file.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool-1" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: { files: [{ filePath: "poem.txt" }] },
          },
        },
      ],
    });
    // The continuation after the tool batch must not carry the @next message.
    const request2 = await h.nextStream();
    expect(hasText(request2, "Then summarize it")).toBe(false);
    expect(thread.queued.next).toHaveLength(1);
    request2.respond({
      stopReason: "end_turn",
      text: "Here is the file.",
      toolRequests: [],
    });
    const request3 = await h.nextStream();
    expect(hasText(request3, "Then summarize it")).toBe(true);
    expect(thread.queued.next).toHaveLength(0);
  }));

it("expands a queued message's commands at delivery, not when it was typed", () =>
  withHarness({ files: { "/project/poem.txt": "original" } }, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "Start something long");
    const request1 = await h.nextStream();
    type(thread, "@next summarize @file:poem.txt");
    expect(thread.queued.next).toHaveLength(1);
    expect(Object.keys(thread.contextFiles.files)).toHaveLength(0);
    await h.fileIO.writeFile("/project/poem.txt", "MUTATED WHILE QUEUED\n");
    request1.respond({
      stopReason: "end_turn",
      text: "done for now",
      toolRequests: [],
    });
    const request2 = await h.nextStream();
    expect(thread.queued.next).toHaveLength(0);
    expect(Object.keys(thread.contextFiles.files)).toHaveLength(1);
    expect(hasText(request2, "MUTATED WHILE QUEUED")).toBe(true);
  }));

it("handles malformed tool_use by sending error tool_result and continuing", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    const done = h.send(thread, "Please read a file");
    const stream = await h.nextStream();
    stream.streamText("Let me read that file.");
    stream.streamToolUse(
      "tool-malformed-1" as ToolRequestId,
      "get_files" as ToolName,
      {},
    );
    stream.finishResponse("tool_use");
    const stream2 = await h.nextStream();
    const toolResult = stream2
      .getProviderMessages()
      .flatMap((m) => m.content)
      .find((b) => b.type === "tool_result");
    expect(toolResult?.type === "tool_result" && toolResult.result.status).toBe(
      "error",
    );
    stream2.respond({
      stopReason: "end_turn",
      text: "Sorry, I made an error with that tool call.",
      toolRequests: [],
    });
    await expect(done).resolves.toMatchObject({ type: "completed" });
  }));

it("forks a thread while streaming without aborting source", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    await exchange(h, thread, "What is 2+2?", "2+2 equals 4.");
    const forkPoint = thread.nativeMessageIdx;
    void h.send(thread, "What about 3+3?");
    const streaming = await h.nextStream();
    const fork = h.thread(await h.session.forkThread(id, forkPoint));
    expect(streaming.aborted).toBe(false);
    expect(loopLabel(thread.loopState)).toBe("streaming");
    void h.send(fork, "Actually, tell me about 5+5");
    const forked = await h.streamWithText("Actually, tell me about 5+5");
    expect(hasText(forked, "2+2 equals 4.")).toBe(true);
    expect(hasText(forked, "3+3")).toBe(false);
    expect(streaming.aborted).toBe(false);
  }));

it("forks a thread while waiting for tool use without aborting source", () =>
  withHarness({}, async (h) => {
    const { id, thread } = await h.createRoot();
    void h.send(thread, "Read my secret file");
    (await h.nextStream()).respond({
      stopReason: "tool_use",
      text: "I'll read your secret file.",
      toolRequests: [bashRequest("bash-tool", "cat .secret")],
    });
    await pendingShell(h);
    expect(loopLabel(thread.loopState)).toBe("running_tools");
    const fork = h.thread(await h.session.forkThread(id));
    void h.send(fork, "Do something else instead");
    const forked = await h.streamWithText("Do something else instead");
    // The fork's clone turns the pending tool_use into an error tool_result.
    const result = forked.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((c) => c.type === "tool_result");
    expect(result).toMatchObject({ tool_use_id: "bash-tool", is_error: true });
    expect(loopLabel(thread.loopState)).toBe("running_tools");
  }));

it("aborts request when sending new message while waiting for response", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "First message");
    const request1 = await h.nextStream();
    const done = h.send(thread, "Second message while first is pending");
    await pollUntil(() => expect(request1.aborted).toBe(true));
    request1.respond({
      stopReason: "end_turn",
      text: "This response should be ignored",
      toolRequests: [],
    });
    const request2 = await h.nextStream();
    request2.respond({
      stopReason: "end_turn",
      text: "Second response that should be shown",
      toolRequests: [],
    });
    await done;
    const texts = JSON.stringify(thread.getProviderMessages());
    expect(texts).toContain("Second message while first is pending");
    expect(texts).toContain("Second response that should be shown");
    expect(texts).not.toContain("This response should be ignored");
  }));

it("inserts error tool results when aborting while waiting for tool use", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "Run a slow command");
    (await h.nextStream()).respond({
      stopReason: "tool_use",
      text: "I'll run a slow bash command for you.",
      toolRequests: [bashRequest("bash-tool", "sleep 5")],
    });
    await pendingShell(h);
    void h.send(thread, "Never mind, do something else");
    const request2 = await h.nextStream();
    expect(wirePattern(request2.messages)).toEqual([
      "user:text",
      "user:text", // system_info
      "user:text", // opening system_reminder
      "assistant:text",
      "assistant:tool_use",
      "user:tool_result", // error tool result from abort
      "user:text", // abort notification
      "user:text",
      "user:text", // system_reminder
    ]);
    const result = request2.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((c) => c.type === "tool_result");
    expect(result).toMatchObject({ tool_use_id: "bash-tool", is_error: true });
    expect(JSON.stringify(result)).toContain("aborted by the user");
  }));

it("aborts tool use when sending new message while tool is executing", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "Run a slow command");
    (await h.nextStream()).respond({
      stopReason: "tool_use",
      text: "I'll run a slow bash command for you.",
      toolRequests: [bashRequest("bash-tool", "slow-command")],
    });
    const call = await pendingShell(h);
    const done = h.send(thread, "Stop, do something else");
    const request2 = await h.nextStream();
    call.result.resolve(shellResult({ stdout: "late tool output" }));
    request2.respond({
      stopReason: "end_turn",
      text: "Okay.",
      toolRequests: [],
    });
    await done;
    const history = JSON.stringify(thread.getProviderMessages());
    expect(history).toContain("Stop, do something else");
    expect(history).not.toContain("late tool output");
    expect(JSON.stringify(request2.messages)).not.toContain("late tool output");
  }));
it("removes server_tool_use content when aborted before receiving results", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "Search for information about TypeScript");
    const request1 = await h.nextStream();
    request1.streamText("I'll search for information about TypeScript.");
    request1.streamServerToolUse("web-search-123", "web_search", {
      query: "TypeScript programming language",
    });
    await pollUntil(() =>
      expect(
        thread
          .getProviderMessages()
          .at(-1)
          ?.content.map((c) => c.type),
      ).toEqual(["text", "server_tool_use"]),
    );
    await thread.abort();
    const assistant = thread
      .getProviderMessages()
      .findLast((m) => m.role === "assistant");
    expect(assistant?.content.map((c) => c.type)).toEqual(["text"]);
  }));
