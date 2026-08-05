import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import type {
  ToolName,
  ToolRequestId,
  ToolStructuredResult,
} from "../tool-types.ts";
import { validateInput } from "../tools/helpers.ts";
import {
  MockOpenAIClient,
  type MockResponseStream,
} from "./mock-openai-client.ts";
import { OpenAIAgent, type OpenAIStreamingClient } from "./openai-agent.ts";
import {
  type Agent,
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderMessage,
  type ProviderToolResult,
  type ProviderToolSpec,
  type StopReason,
  type Usage,
} from "./provider-types.ts";

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const spec: ProviderToolSpec = {
  name: "get_files" as ToolName,
  description: "gets files",
  input_schema: {
    type: "object",
    properties: { filePath: { type: "string" } },
  } as ProviderToolSpec["input_schema"],
};

function setup(options: { includeWebSearch?: boolean } = {}) {
  const client = new MockOpenAIClient();
  const agent = new OpenAIAgent(
    {
      model: "gpt-5.4",
      systemPrompt: "be helpful",
      tools: [spec],
    },
    client as unknown as OpenAIStreamingClient,
    {
      includeWebSearch: options.includeWebSearch ?? false,
      logger: noopLogger,
      validateInput,
    },
  );
  return { client, agent };
}

function stoppedPromise(
  agent: Agent,
): Promise<{ stopReason: StopReason; usage: Usage | undefined }> {
  return new Promise((resolve) => {
    agent.on("stopped", (stopReason, usage) => resolve({ stopReason, usage }));
  });
}

function userText(text: string) {
  return {
    type: "text" as const,
    text,
    nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
  };
}

async function startTurn(
  client: MockOpenAIClient,
  agent: Agent,
  text = "hello",
): Promise<MockResponseStream> {
  agent.appendUserMessage([userText(text)]);
  agent.continueConversation();
  return client.awaitStream();
}

function okToolResult(text: string): ProviderToolResult {
  return {
    type: "tool_result",
    id: "call_1" as ToolRequestId,
    result: {
      status: "ok",
      value: [userText(text)],
      structuredResult: {
        status: "ok",
        value: "",
      } as unknown as ToolStructuredResult,
    },
    nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
  };
}

function assistant(agent: Agent): ProviderMessage {
  const messages = agent.getState().messages;
  const last = messages[messages.length - 1];
  expect(last.role).toBe("assistant");
  return last;
}

describe("OpenAIAgent text turns", () => {
  it("commits each completed item as it arrives, before the turn ends", async () => {
    const { client, agent } = setup({ includeWebSearch: true });
    const stream = await startTurn(client, agent);
    stream.streamWebSearchCall("denis lantsman");
    await stream.settle();
    // Without incremental commits the message only materializes at
    // response.completed, so the search never renders while it is running.
    expect(assistant(agent).content).toMatchObject([
      { type: "server_tool_use", name: "web_search" },
    ]);
    stream.streamText("an answer");
    await stream.settle();
    expect(assistant(agent).content).toHaveLength(2);
    expect(agent.getState().messages).toHaveLength(2);
  });

  it("exposes completed blocks alongside the in-flight one mid-stream", async () => {
    const { client, agent } = setup({ includeWebSearch: true });
    const stream = await startTurn(client, agent);
    stream.streamReasoningSummary(["let me look that up"]);
    stream.streamWebSearchCall("denis lantsman");
    // A message item that has started but not finished: what the view shows as
    // the streaming block while the rest of the turn is already committed.
    stream.emitEvent({
      type: "response.output_item.added",
      output_index: 9,
      item: {
        type: "message",
        id: "msg_partial",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    });
    stream.emitEvent({
      type: "response.output_text.delta",
      output_index: 9,
      item_id: "msg_partial",
      content_index: 0,
      delta: "Denis is",
      logprobs: [],
    });
    await stream.settle();

    expect(assistant(agent).content).toMatchObject([
      { type: "thinking", thinking: "let me look that up" },
      { type: "server_tool_use", name: "web_search" },
    ]);
    expect(agent.getState().streamingBlock).toEqual({
      type: "text",
      text: "Denis is",
    });
  });
  it("streams text, emits didUpdate, and stops with usage", async () => {
    const { client, agent } = setup();
    let updates = 0;
    agent.on("didUpdate", () => updates++);
    const stopped = stoppedPromise(agent);

    const stream = await startTurn(client, agent);
    expect(stream.instructions).toBe("be helpful");

    stream.streamText("hi there");
    await stream.settle();
    stream.finishResponse("end_turn", {
      inputTokens: 100,
      outputTokens: 5,
      cacheHits: 64,
    });

    const result = await stopped;
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      cacheHits: 64,
    });
    expect(updates).toBeGreaterThan(0);

    const message = assistant(agent);
    expect(message.content[0]).toMatchObject({
      type: "text",
      text: "hi there",
    });
    expect(message.stopReason).toBe("end_turn");
    expect(agent.getState().status).toEqual({
      type: "stopped",
      stopReason: "end_turn",
    });
    expect(agent.getStreamingBlock()).toBeUndefined();
  });

  it("exposes the partially accumulated text as the streaming block", async () => {
    const { client, agent } = setup();
    const stream = await startTurn(client, agent);
    stream.emitEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    });
    stream.emitEvent({
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "msg_1",
      content_index: 0,
      delta: "par",
      logprobs: [],
    });
    await stream.settle();
    expect(agent.getStreamingBlock()).toEqual({ type: "text", text: "par" });
  });

  it("sends one stable prompt_cache_key for every turn and its clones", async () => {
    const { client, agent } = setup();
    const first = await startTurn(client, agent);
    const key = first.params.prompt_cache_key;
    expect(typeof key).toBe("string");
    first.streamText("one");
    await first.settle();
    first.finishResponse();

    agent.appendUserMessage([userText("again")]);
    agent.continueConversation();
    const second = await client.awaitStream();
    expect(second.params.prompt_cache_key).toBe(key);
    second.finishResponse();

    const cloned = agent.clone();
    cloned.appendUserMessage([userText("clone")]);
    cloned.continueConversation();
    const third = await client.awaitStream();
    expect(third.params.prompt_cache_key).toBe(key);
    third.finishResponse();
  });
});

describe("OpenAIAgent tool calls", () => {
  it("surfaces a tool_use block and echoes the call plus its output", async () => {
    const { client, agent } = setup();
    const stopped = stoppedPromise(agent);
    const stream = await startTurn(client, agent);

    stream.streamToolCall("call_1", "get_files", {
      files: [{ filePath: "a.ts" }],
    });
    await stream.settle();
    stream.finishResponse();

    expect((await stopped).stopReason).toBe("tool_use");

    const toolUse = assistant(agent).content[0];
    expect(toolUse).toMatchObject({ type: "tool_use", id: "call_1" });
    if (toolUse.type !== "tool_use" || toolUse.request.status !== "ok") {
      throw new Error("expected a valid tool_use request");
    }
    expect(toolUse.request.value.input).toEqual({
      files: [{ filePath: "a.ts" }],
    });

    agent.toolResult("call_1" as ToolRequestId, okToolResult("file contents"));
    agent.continueConversation();
    const followup = await client.awaitStream();

    expect(followup.inputItemsOfType("function_call")).toHaveLength(1);
    const outputs = followup.inputItemsOfType("function_call_output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      call_id: "call_1",
      output: "file contents",
    });
    followup.finishResponse();
  });

  it("keys parallel tool calls on output_index", async () => {
    const { client, agent } = setup();
    const stopped = stoppedPromise(agent);
    const stream = await startTurn(client, agent);

    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    stream.streamToolCall("call_2", "get_files", { filePath: "b.ts" });
    await stream.settle();
    stream.finishResponse();

    expect((await stopped).stopReason).toBe("tool_use");
    const toolUses = assistant(agent).content.filter(
      (c) => c.type === "tool_use",
    );
    expect(toolUses.map((t) => t.id)).toEqual(["call_1", "call_2"]);

    agent.toolResult("call_1" as ToolRequestId, okToolResult("a"));
    agent.toolResult("call_2" as ToolRequestId, {
      ...okToolResult("b"),
      id: "call_2" as ToolRequestId,
    });
    agent.continueConversation();
    const followup = await client.awaitStream();
    expect(followup.inputItemsOfType("function_call_output")).toHaveLength(2);
    followup.finishResponse();
  });
});

describe("OpenAIAgent reasoning", () => {
  it("folds many summary parts into one thinking block", async () => {
    const { client, agent } = setup();
    const stopped = stoppedPromise(agent);
    const stream = await startTurn(client, agent);

    stream.streamReasoningSummary(["first", "second", "third"], {
      itemId: "rs_1",
      encryptedContent: "enc-1",
    });
    stream.streamText("done");
    await stream.settle();
    stream.finishResponse();
    await stopped;

    const thinking = assistant(agent).content.filter(
      (c) => c.type === "thinking",
    );
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({
      thinking: "first\n\nsecond\n\nthird",
      signature: "enc-1",
      providerMetadata: { provider: "openai", itemId: "rs_1" },
    });

    agent.appendUserMessage([userText("more")]);
    agent.continueConversation();
    const followup = await client.awaitStream();
    const reasoning = followup.inputItemsOfType("reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].encrypted_content).toBe("enc-1");
    followup.finishResponse();
  });

  it("round-trips an empty-summary reasoning item", async () => {
    const { client, agent } = setup();
    const stopped = stoppedPromise(agent);
    const stream = await startTurn(client, agent);

    stream.streamEmptyReasoning("enc-empty", "rs_empty");
    stream.streamText("ok");
    await stream.settle();
    stream.finishResponse();
    await stopped;

    const thinking = assistant(agent).content.find(
      (c) => c.type === "thinking",
    );
    expect(thinking).toMatchObject({ thinking: "", signature: "enc-empty" });

    agent.appendUserMessage([userText("again")]);
    agent.continueConversation();
    const followup = await client.awaitStream();
    expect(followup.inputItemsOfType("reasoning")[0]).toMatchObject({
      id: "rs_empty",
      encrypted_content: "enc-empty",
      summary: [],
    });
    followup.finishResponse();
  });
});

describe("OpenAIAgent web search", () => {
  it("keeps the search call and its annotations across turns", async () => {
    const { client, agent } = setup({ includeWebSearch: true });
    const stopped = stoppedPromise(agent);
    const stream = await startTurn(client, agent);

    const annotation: OpenAI.Responses.ResponseOutputText.URLCitation = {
      type: "url_citation",
      start_index: 0,
      end_index: 3,
      title: "Example",
      url: "https://example.com",
    };
    stream.streamWebSearchCall("magenta nvim", { itemId: "ws_1" });
    stream.streamAnnotatedText("per the docs", [annotation]);
    await stream.settle();
    stream.finishResponse();
    await stopped;

    const content = assistant(agent).content;
    expect(content[0]).toMatchObject({
      type: "server_tool_use",
      name: "web_search",
      input: { query: "magenta nvim" },
    });
    const text = content.find((c) => c.type === "text");
    expect(text?.citations?.[0]).toMatchObject({
      title: "Example",
      url: "https://example.com",
    });

    agent.appendUserMessage([userText("thanks")]);
    agent.continueConversation();
    const followup = await client.awaitStream();
    expect(followup.inputItemsOfType("web_search_call")[0]).toMatchObject({
      id: "ws_1",
    });
    followup.finishResponse();
  });
});

describe("OpenAIAgent abort", () => {
  it("synthesizes a stopped state when the stream just ends", async () => {
    const { client, agent } = setup();
    const stopped = stoppedPromise(agent);
    const stream = await startTurn(client, agent);

    stream.emitEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    });
    stream.emitEvent({
      type: "response.output_text.delta",
      output_index: 0,
      item_id: "msg_1",
      content_index: 0,
      delta: "partial answer",
      logprobs: [],
    });
    await stream.settle();

    const done = agent.abort();
    stream.abortMidstream();
    await done;

    const result = await stopped;
    expect(result.stopReason).toBe("aborted");
    expect(result.usage).toBeUndefined();
    expect(agent.getState().latestUsage).toBeUndefined();
    expect(assistant(agent).content[0]).toMatchObject({
      type: "text",
      text: "partial answer",
    });
    expect(agent.getStreamingBlock()).toBeUndefined();
  });

  it("drops a tool call that was never dispatched", async () => {
    const { client, agent } = setup();
    const stopped = stoppedPromise(agent);
    const stream = await startTurn(client, agent);
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await stream.settle();

    const done = agent.abort();
    stream.abortMidstream();
    await done;
    expect((await stopped).stopReason).toBe("aborted");

    const messages = agent.getState().messages;
    expect(
      messages.some((m) => m.content.some((c) => c.type === "tool_use")),
    ).toBe(false);
  });
});

describe("OpenAIAgent invariant guards", () => {
  it("toolResult rejects a non-tool_use stopped state", async () => {
    const { client, agent } = setup();
    const stopped = stoppedPromise(agent);
    const stream = await startTurn(client, agent);
    stream.streamText("just text");
    await stream.settle();
    stream.finishResponse();
    await stopped;

    expect(() =>
      agent.toolResult("call_1" as ToolRequestId, okToolResult("x")),
    ).toThrow(/expected status stopped with stopReason tool_use/);
  });

  it("toolResult rejects an unknown tool_use id", async () => {
    const { client, agent } = setup();
    const stopped = stoppedPromise(agent);
    const stream = await startTurn(client, agent);
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await stream.settle();
    stream.finishResponse();
    await stopped;

    expect(() =>
      agent.toolResult("call_missing" as ToolRequestId, {
        ...okToolResult("x"),
        id: "call_missing" as ToolRequestId,
      }),
    ).toThrow(/no tool_use block with id call_missing/);
  });

  it("abortToolUse rejects a non-tool_use stopped state", async () => {
    const { client, agent } = setup();
    const stopped = stoppedPromise(agent);
    const stream = await startTurn(client, agent);
    stream.streamText("just text");
    await stream.settle();
    stream.finishResponse();
    await stopped;

    expect(() => agent.abortToolUse()).toThrow(/Cannot abort tool use/);
  });

  it("abortToolUse flips a pending tool_use to aborted", async () => {
    const { client, agent } = setup();
    const stopped = stoppedPromise(agent);
    const stream = await startTurn(client, agent);
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await stream.settle();
    stream.finishResponse();
    await stopped;

    const aborted = stoppedPromise(agent);
    agent.abortToolUse();
    expect((await aborted).stopReason).toBe("aborted");
    expect(agent.getState().status).toEqual({
      type: "stopped",
      stopReason: "aborted",
    });
  });
});

describe("OpenAIAgent clone", () => {
  it("returns a stopped deep copy with history intact", async () => {
    const { client, agent } = setup();
    const stopped = stoppedPromise(agent);
    const stream = await startTurn(client, agent);
    stream.streamText("original");
    await stream.settle();
    stream.finishResponse();
    await stopped;

    const cloned = agent.clone();
    expect(cloned.getState().status).toEqual({
      type: "stopped",
      stopReason: "end_turn",
    });
    expect(cloned.getStreamingBlock()).toBeUndefined();
    expect(cloned.getState().messages).toHaveLength(2);
    expect(cloned.getState().messages[1].content[0]).toMatchObject({
      type: "text",
      text: "original",
    });

    cloned.appendUserMessage([userText("only in the clone")]);
    expect(agent.getState().messages).toHaveLength(2);
  });

  it("drops an unanswered tool call in the clone", async () => {
    const { client, agent } = setup();
    const stopped = stoppedPromise(agent);
    const stream = await startTurn(client, agent);
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await stream.settle();
    stream.finishResponse();
    await stopped;

    const cloned = agent.clone();
    expect(
      cloned
        .getState()
        .messages.some((m) => m.content.some((c) => c.type === "tool_use")),
    ).toBe(false);
  });
});

describe("OpenAIAgent truncation", () => {
  it("keeps messages up to the given index and stops", async () => {
    const { client, agent } = setup();
    const stopped = stoppedPromise(agent);
    const stream = await startTurn(client, agent);
    stream.streamText("first");
    await stream.settle();
    stream.finishResponse();
    await stopped;

    const idx = agent.getNativeMessageIdx();
    agent.appendUserMessage([userText("second")]);
    agent.truncateMessages(idx);

    expect(agent.getState().messages).toHaveLength(2);
    expect(agent.getState().status).toEqual({
      type: "stopped",
      stopReason: "end_turn",
    });
  });

  it("drops a tool_use severed from its tool_result", async () => {
    const { client, agent } = setup();
    const stopped = stoppedPromise(agent);
    const stream = await startTurn(client, agent);
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await stream.settle();
    stream.finishResponse();
    await stopped;

    const assistantIdx = agent.getNativeMessageIdx();
    agent.toolResult("call_1" as ToolRequestId, okToolResult("contents"));

    // Truncating back to the assistant message severs the tool_use from its
    // result; the backend rejects such a request, so it must be dropped.
    agent.truncateMessages(assistantIdx);
    const messages = agent.getState().messages;
    expect(
      messages.some((m) => m.content.some((c) => c.type === "tool_use")),
    ).toBe(false);

    agent.appendUserMessage([userText("carry on")]);
    agent.continueConversation();
    const followup = await client.awaitStream();
    expect(followup.inputItemsOfType("function_call")).toHaveLength(0);
    followup.finishResponse();
  });
});
