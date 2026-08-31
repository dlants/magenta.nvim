import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import type { Agent, ToolExecutor } from "../agent.ts";
import { createTestOpenAIAgent, flatPhase } from "../test-helpers.ts";
import type { ToolName, ToolStructuredResult } from "../tool-types.ts";
import { ABORT_TOOL_RESULT_TEXT } from "./inference-shared.ts";
import type {
  MockOpenAIClient,
  MockResponseStream,
} from "./mock-openai-client.ts";
import {
  type NativeInferenceManager,
  type NativeMessageIdx,
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderMessage,
  type ProviderToolResult,
  type ProviderToolSpec,
  type RequestedTool,
  type ToolResults,
  type TurnResult,
} from "./provider-types.ts";

const spec: ProviderToolSpec = {
  name: "get_files" as ToolName,
  description: "gets files",
  input_schema: {
    type: "object",
    properties: { filePath: { type: "string" } },
  } as ProviderToolSpec["input_schema"],
};

function userText(text: string) {
  return {
    type: "text" as const,
    text,
    nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
  };
}

function okResult(text: string): ProviderToolResult["result"] {
  return {
    status: "ok",
    value: [userText(text)],
    structuredResult: {
      status: "ok",
      value: "",
    } as unknown as ToolStructuredResult,
  };
}

/** The stand-in Agent: answers every request and lets the turn continue. */
function okResults(
  requests: ReadonlyArray<RequestedTool>,
  text = "tool output",
): ToolResults {
  return new Map(requests.map((request) => [request.id, okResult(text)]));
}

function setup(
  options: {
    includeWebSearch?: boolean;
    executeTools?: ToolExecutor;
    client?: MockOpenAIClient;
  } = {},
) {
  const calls: RequestedTool[][] = [];
  const state = { updates: 0 };
  const executeTools: ToolExecutor = (requests) => {
    calls.push([...requests]);
    return (
      options.executeTools ??
      ((reqs: ReadonlyArray<RequestedTool>) =>
        Promise.resolve({
          type: "continue" as const,
          results: okResults(reqs),
        }))
    )(requests);
  };
  const { agent, mockClient: client } = createTestOpenAIAgent({
    ...(options.client ? { mockClient: options.client } : {}),
    tools: [spec],
    executeTools,
    onUpdate: () => {
      state.updates++;
    },
    openaiOptions: { includeWebSearch: options.includeWebSearch ?? false },
  });
  return { client, agent, calls, state };
}

/** Start a turn and wait for the request it issues. `awaitStream` would hand
 * back the previous, already-finished stream, so index from where we are. */
async function startTurn(
  client: MockOpenAIClient,
  agent: Agent,
  text = "hello",
): Promise<{ turn: Promise<TurnResult>; stream: MockResponseStream }> {
  const next = client.streams.length;
  const turn = agent.runTurnLoop([userText(text)]);
  const stream = await client.awaitStreamAt(next);
  return { turn, stream };
}

function assistant(agent: Agent): ProviderMessage {
  const messages = agent.manager.log.messages;
  const last = messages[messages.length - 1];
  expect(last.role).toBe("assistant");
  return last;
}

/** The last assistant message, which an aborted turn leaves behind its own
 * user-role abort marker. */
function lastAssistant(agent: Agent): ProviderMessage {
  const messages = agent.manager.log.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i];
  }
  throw new Error("no assistant message");
}

function streamingBlock(agent: Agent) {
  const phase = flatPhase(agent);
  return phase.type === "streaming" ? phase.block : undefined;
}

function toolUseBlocks(agent: Agent) {
  return agent.manager.log.messages.flatMap((message) =>
    message.content.filter((content) => content.type === "tool_use"),
  );
}
describe("OpenAIInferenceManager text turns", () => {
  it("commits each completed item as it arrives, before the turn ends", async () => {
    const { client, agent } = setup({ includeWebSearch: true });
    const { turn, stream } = await startTurn(client, agent);
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
    expect(agent.manager.log.messages).toHaveLength(2);

    stream.finishResponse();
    await turn;
  });

  it("exposes completed blocks alongside the in-flight one mid-stream", async () => {
    const { client, agent } = setup({ includeWebSearch: true });
    const { turn, stream } = await startTurn(client, agent);
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
    expect(streamingBlock(agent)).toEqual({
      type: "text",
      text: "Denis is",
    });

    stream.finishResponse();
    await turn;
  });

  it("streams text, calls onUpdate, and resolves the turn with usage recorded", async () => {
    const { client, agent, state } = setup();

    const { turn, stream } = await startTurn(client, agent);
    expect(stream.instructions).toBe("test system prompt");

    stream.streamText("hi there");
    await stream.settle();
    stream.finishResponse("end_turn", {
      inputTokens: 100,
      outputTokens: 5,
      cacheHits: 64,
    });

    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });
    expect(agent.manager.log.latestUsage).toEqual({
      inputTokens: 100,
      outputTokens: 5,
      cacheHits: 64,
    });
    expect(state.updates).toBeGreaterThan(0);

    const message = assistant(agent);
    expect(message.content[0]).toMatchObject({
      type: "text",
      text: "hi there",
    });
    expect(message.stopReason).toBe("end_turn");
    expect(flatPhase(agent)).toEqual({ type: "idle" });
  });

  it("exposes the partially accumulated text as the streaming block", async () => {
    const { client, agent } = setup();
    const { turn, stream } = await startTurn(client, agent);
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
    expect(streamingBlock(agent)).toEqual({ type: "text", text: "par" });

    stream.finishResponse();
    await turn;
  });

  it("sends one stable prompt_cache_key for every turn and its clones", async () => {
    const { client, agent } = setup();
    const first = await startTurn(client, agent);
    const key = first.stream.params.prompt_cache_key;
    expect(typeof key).toBe("string");
    first.stream.streamText("one");
    await first.stream.settle();
    first.stream.finishResponse();
    await first.turn;

    const second = await startTurn(client, agent, "again");
    expect(second.stream.params.prompt_cache_key).toBe(key);
    second.stream.finishResponse();
    await second.turn;

    const { agent: cloned } = createTestOpenAIAgent({
      mockClient: client,
      tools: [spec],
      cloneFrom: agent.manager,
    });
    const third = await startTurn(client, cloned, "clone");
    expect(third.stream.params.prompt_cache_key).toBe(key);
    third.stream.finishResponse();
    await third.turn;
  });
});

describe("OpenAIInferenceManager tool calls", () => {
  it("surfaces a tool_use block and echoes the call plus its output", async () => {
    const { client, agent, calls } = setup({
      executeTools: (requests) =>
        Promise.resolve({
          type: "continue",
          results: okResults(requests, "file contents"),
        }),
    });
    const { turn, stream } = await startTurn(client, agent);

    stream.streamToolCall("call_1", "get_files", {
      files: [{ filePath: "a.ts" }],
    });
    await stream.settle();
    stream.finishResponse();

    const followup = await client.awaitStreamAt(1);

    expect(agent.manager.log.messages[1].stopReason).toBe("tool_use");
    expect(calls).toHaveLength(1);
    expect(calls[0].map((request) => request.id)).toEqual(["call_1"]);

    const toolUse = toolUseBlocks(agent)[0];
    expect(toolUse).toMatchObject({ type: "tool_use", id: "call_1" });
    if (toolUse.type !== "tool_use" || toolUse.request.status !== "ok") {
      throw new Error("expected a valid tool_use request");
    }
    expect(toolUse.request.value.input).toEqual({
      files: [{ filePath: "a.ts" }],
    });

    expect(followup.inputItemsOfType("function_call")).toHaveLength(1);
    const outputs = followup.inputItemsOfType("function_call_output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      call_id: "call_1",
      output: "file contents",
    });
    followup.finishResponse();
    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });
  });

  it("keys parallel tool calls on output_index", async () => {
    const { client, agent, calls } = setup();
    const { turn, stream } = await startTurn(client, agent);

    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    stream.streamToolCall("call_2", "get_files", { filePath: "b.ts" });
    await stream.settle();
    stream.finishResponse();

    const followup = await client.awaitStreamAt(1);
    expect(agent.manager.log.messages[1].stopReason).toBe("tool_use");
    expect(toolUseBlocks(agent).map((t) => t.id)).toEqual(["call_1", "call_2"]);
    expect(calls[0].map((request) => request.id)).toEqual(["call_1", "call_2"]);
    expect(followup.inputItemsOfType("function_call_output")).toHaveLength(2);
    followup.finishResponse();
    await turn;
  });

  it("records the results and parks the agent when the executor suspends", async () => {
    const { client, agent } = setup({
      executeTools: (requests) =>
        Promise.resolve({
          type: "suspend",
          results: okResults(requests, "yielded"),
        }),
    });
    const { turn, stream } = await startTurn(client, agent);
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await stream.settle();
    stream.finishResponse();

    expect(await turn).toEqual({ type: "suspended" });
    // No continuation request: the turn ends where the executor said it does.
    expect(client.streams).toHaveLength(1);
    const results = agent.manager.log.messages.flatMap((message) =>
      message.content.filter((content) => content.type === "tool_result"),
    );
    expect(results.map((result) => result.id)).toEqual(["call_1"]);
    expect(flatPhase(agent)).toEqual({ type: "idle" });
  });
});

describe("OpenAIInferenceManager reasoning", () => {
  it("folds many summary parts into one thinking block", async () => {
    const { client, agent } = setup();
    const { turn, stream } = await startTurn(client, agent);

    stream.streamReasoningSummary(["first", "second", "third"], {
      itemId: "rs_1",
      encryptedContent: "enc-1",
    });
    stream.streamText("done");
    await stream.settle();
    stream.finishResponse();
    await turn;

    const thinking = assistant(agent).content.filter(
      (c) => c.type === "thinking",
    );
    expect(thinking).toHaveLength(1);
    expect(thinking[0]).toMatchObject({
      thinking: "first\n\nsecond\n\nthird",
      signature: "enc-1",
    });

    const next = await startTurn(client, agent, "more");
    const reasoning = next.stream.inputItemsOfType("reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].encrypted_content).toBe("enc-1");
    next.stream.finishResponse();
    await next.turn;
  });

  it("echoes the turn's reasoning and function_call items byte-for-byte", async () => {
    const { client, agent } = setup();
    const { turn, stream } = await startTurn(client, agent);
    stream.streamReasoningSummary(["weighing it up"], {
      itemId: "rs_wire",
      encryptedContent: "enc-wire",
    });
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await stream.settle();
    const sent = stream.getOutputItems();
    stream.finishResponse();

    const followup = await client.awaitStreamAt(1);
    // The native items are the source of truth, so the next request carries
    // exactly what the stream delivered rather than a reconstruction.
    expect(followup.inputItemsOfType("reasoning")).toEqual(
      sent.filter((item) => item.type === "reasoning"),
    );
    expect(followup.inputItemsOfType("function_call")).toEqual(
      sent.filter((item) => item.type === "function_call"),
    );
    followup.finishResponse();
    await turn;
  });

  it("round-trips an empty-summary reasoning item", async () => {
    const { client, agent } = setup();
    const { turn, stream } = await startTurn(client, agent);

    stream.streamEmptyReasoning("enc-empty", "rs_empty");
    stream.streamText("ok");
    await stream.settle();
    stream.finishResponse();
    await turn;

    const thinking = assistant(agent).content.find(
      (c) => c.type === "thinking",
    );
    expect(thinking).toMatchObject({ thinking: "", signature: "enc-empty" });

    const next = await startTurn(client, agent, "again");
    expect(next.stream.inputItemsOfType("reasoning")[0]).toMatchObject({
      id: "rs_empty",
      encrypted_content: "enc-empty",
      summary: [],
    });
    next.stream.finishResponse();
    await next.turn;
  });
});

describe("OpenAIInferenceManager web search", () => {
  it("keeps the search call and its annotations across turns", async () => {
    const { client, agent } = setup({ includeWebSearch: true });
    const { turn, stream } = await startTurn(client, agent);

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
    await turn;

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

    const next = await startTurn(client, agent, "thanks");
    expect(next.stream.inputItemsOfType("web_search_call")[0]).toMatchObject({
      id: "ws_1",
    });
    next.stream.finishResponse();
    await next.turn;
  });
});

describe("OpenAIInferenceManager abort", () => {
  it("unwinds the turn when the stream just ends", async () => {
    const { client, agent } = setup();
    const { turn, stream } = await startTurn(client, agent);

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

    agent.abort();
    stream.abortMidstream();

    expect(await turn).toEqual({ type: "aborted" });
    expect(agent.manager.log.latestUsage).toBeUndefined();
    expect(lastAssistant(agent).content[0]).toMatchObject({
      type: "text",
      text: "partial answer",
    });
    expect(flatPhase(agent)).toEqual({ type: "idle" });
  });

  it("drops a tool call that was never dispatched", async () => {
    const { client, agent, calls } = setup();
    const { turn, stream } = await startTurn(client, agent);
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await stream.settle();

    agent.abort();
    stream.abortMidstream();
    expect(await turn).toEqual({ type: "aborted" });

    expect(calls).toHaveLength(0);
    expect(toolUseBlocks(agent)).toHaveLength(0);
  });

  it("drops the reasoning stranded by an undispatched tool call", async () => {
    const { client, agent } = setup();
    const { turn, stream } = await startTurn(client, agent);
    stream.streamReasoningSummary(["about to call a tool"], {
      itemId: "rs_1",
      encryptedContent: "enc-1",
    });
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await stream.settle();

    agent.abort();
    stream.abortMidstream();
    expect(await turn).toEqual({ type: "aborted" });

    // The backend rejects a reasoning item that is not followed by the output
    // it reasons about, so dropping the call must drop the reasoning too.
    const next = await startTurn(client, agent, "carry on");
    expect(next.stream.inputItemsOfType("function_call")).toHaveLength(0);
    expect(next.stream.inputItemsOfType("reasoning")).toHaveLength(0);
    next.stream.finishResponse();
    await next.turn;
  });

  it("unwinds when the executor reports that it aborted its tools", async () => {
    const { client, agent } = setup({
      executeTools: () =>
        Promise.resolve({ type: "aborted", results: new Map() }),
    });
    const { turn, stream } = await startTurn(client, agent);
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await stream.settle();
    stream.finishResponse();

    expect(await turn).toEqual({ type: "aborted" });
    expect(client.streams).toHaveLength(1);
    // An aborted tool_use is still answered, so the history stays well-formed.
    expect(toolUseBlocks(agent)).toHaveLength(1);
    const results = agent.manager.log.messages.flatMap((message) =>
      message.content.filter((content) => content.type === "tool_result"),
    );
    expect(results).toHaveLength(1);
    // The wire format has no error flag on a function_call_output, so the
    // ok/error distinction is not recoverable from the native items; only the
    // text survives.
    expect(results[0].result).toMatchObject({
      status: "ok",
      value: [{ type: "text", text: ABORT_TOOL_RESULT_TEXT }],
    });
  });
});

describe("OpenAIInferenceManager invariant guards", () => {
  it("answers an id the executor omitted", async () => {
    const { client, agent } = setup({
      executeTools: () =>
        Promise.resolve({ type: "continue", results: new Map() }),
    });
    const { turn, stream } = await startTurn(client, agent);
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await stream.settle();
    stream.finishResponse();

    const followup = await client.awaitStreamAt(1);
    const outputs = followup.inputItemsOfType("function_call_output");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      call_id: "call_1",
      output: ABORT_TOOL_RESULT_TEXT,
    });
    followup.finishResponse();
    await turn;
  });

  it("answers every id when the executor rejects", async () => {
    const { client, agent } = setup({
      executeTools: () => Promise.reject(new Error("executor blew up")),
    });
    const { turn, stream } = await startTurn(client, agent);
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await stream.settle();
    stream.finishResponse();

    const followup = await client.awaitStreamAt(1);
    expect(followup.inputItemsOfType("function_call_output")).toMatchObject([
      { call_id: "call_1", output: ABORT_TOOL_RESULT_TEXT },
    ]);
    followup.finishResponse();
    await turn;
  });

  it("rejects a second turn while one is in flight", async () => {
    const { client, agent } = setup();
    const { turn, stream } = await startTurn(client, agent);

    await expect(agent.runTurnLoop([userText("again")])).rejects.toThrow(
      /already in flight/,
    );
    // The rejected call must not have perturbed the history.
    expect(agent.manager.log.messages).toHaveLength(1);

    stream.streamText("hi");
    await stream.settle();
    stream.finishResponse();
    expect(await turn).toEqual({ type: "stopped", stopReason: "end_turn" });
  });
});

describe("OpenAIInferenceManager clone", () => {
  it("returns an idle deep copy with history intact", async () => {
    const { client, agent } = setup();
    const { turn, stream } = await startTurn(client, agent);
    stream.streamText("original");
    await stream.settle();
    stream.finishResponse();
    await turn;

    const { agent: cloned } = createTestOpenAIAgent({
      mockClient: client,
      tools: [spec],
      cloneFrom: agent.manager,
    });
    expect(flatPhase(cloned)).toEqual({ type: "idle" });
    expect(cloned.manager.log.messages).toHaveLength(2);
    expect(cloned.manager.log.messages[1].content[0]).toMatchObject({
      type: "text",
      text: "original",
    });

    const clonedTurn = await startTurn(client, cloned, "only in the clone");
    expect(agent.manager.log.messages).toHaveLength(2);
    expect(cloned.manager.log.messages).toHaveLength(3);
    clonedTurn.stream.finishResponse();
    await clonedTurn.turn;
  });

  it("drops an unanswered tool call in the clone", async () => {
    // Cloning mid-tool-execution is the one moment a tool_use has no result
    // yet, which is exactly when a fork can happen.
    let midToolClone: NativeInferenceManager | undefined;
    const { client, agent } = setup({
      executeTools: (requests) => {
        midToolClone = agent.manager.clone();
        return Promise.resolve({
          type: "continue",
          results: okResults(requests),
        });
      },
    });
    const { turn, stream } = await startTurn(client, agent);
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await stream.settle();
    stream.finishResponse();

    const followup = await client.awaitStreamAt(1);
    followup.finishResponse();
    await turn;

    expect(midToolClone).toBeDefined();
    expect(
      midToolClone!.log.messages.some((m) =>
        m.content.some((c) => c.type === "tool_use"),
      ),
    ).toBe(false);
  });
});

describe("OpenAIInferenceManager truncation", () => {
  it("keeps messages up to the given index", async () => {
    const { client, agent } = setup();
    const first = await startTurn(client, agent);
    first.stream.streamText("first");
    await first.stream.settle();
    first.stream.finishResponse();
    await first.turn;

    const idx = agent.manager.getNativeMessageIdx();
    const second = await startTurn(client, agent, "second");
    second.stream.streamText("second answer");
    await second.stream.settle();
    second.stream.finishResponse();
    await second.turn;
    expect(agent.manager.log.messages).toHaveLength(4);

    agent.manager.truncateMessages(idx);
    expect(agent.manager.log.messages).toHaveLength(2);
    expect(flatPhase(agent)).toEqual({ type: "idle" });
  });

  it("drops a tool_use severed from its tool_result", async () => {
    const { client, agent } = setup();
    const { turn, stream } = await startTurn(client, agent);
    stream.streamToolCall("call_1", "get_files", { filePath: "a.ts" });
    await stream.settle();
    stream.finishResponse();
    const followup = await client.awaitStreamAt(1);
    followup.finishResponse();
    await turn;

    const assistantIdx = agent.manager.log.messages.findIndex((message) =>
      message.content.some((content) => content.type === "tool_use"),
    ) as NativeMessageIdx;

    // Truncating back to the assistant message severs the tool_use from its
    // result; the backend rejects such a request, so it must be dropped.
    agent.manager.truncateMessages(assistantIdx);
    expect(toolUseBlocks(agent)).toHaveLength(0);

    const next = await startTurn(client, agent, "carry on");
    expect(next.stream.inputItemsOfType("function_call")).toHaveLength(0);
    next.stream.finishResponse();
    await next.turn;
  });
});
