import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type OpenAI from "openai";
import { APIError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ToolName,
  ToolRequestId,
  ToolStructuredResult,
} from "../tool-types.ts";
import { validateInput } from "../tools/helpers.ts";
import { RETRY_DELAYS } from "./anthropic-runner.ts";
import {
  MockOpenAIClient,
  type MockResponseStream,
} from "./mock-openai-client.ts";
import {
  convertResponseOutputToProviderContent,
  createStreamParameters,
  isReasoningModel,
  makeOpenAICompatible,
  mapResponseStreamEvent,
  OpenAIProvider,
  type OpenAIProviderOptions,
  sanitizeSchemaForOpenAI,
  supportsWebSearch,
} from "./openai.ts";
import {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderMessage,
  type ProviderMessageContent,
  type ProviderStreamEvent,
  type ProviderToolResultContent,
  type ProviderToolSpec,
} from "./provider-types.ts";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "openai",
);

function fixtureEventTypes(name: string, turn = 0): string[] {
  const data = JSON.parse(
    readFileSync(path.join(fixtureDir, `${name}.json`), "utf8"),
  ) as { turns: { events: { type: string }[] }[] };
  return data.turns[turn].events.map((e) => e.type);
}

const tool = (name: string): ProviderToolSpec => ({
  name: name as ToolName,
  description: `does ${name}`,
  input_schema: {
    type: "object",
    properties: { path: { type: "string", format: "uri" } },
  } as ProviderToolSpec["input_schema"],
});

function userMessage(text: string): ProviderMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ],
  };
}

function assistantMessage(content: ProviderMessageContent[]): ProviderMessage {
  return { role: "assistant", content };
}

describe("model capability helpers", () => {
  it("classifies reasoning models and web search support", () => {
    expect(isReasoningModel("gpt-5.4")).toBe(true);
    expect(isReasoningModel("o3-mini")).toBe(true);
    expect(isReasoningModel("gpt-4o")).toBe(false);
    expect(supportsWebSearch("gpt-4o")).toBe(true);
    expect(supportsWebSearch("gpt-5.4")).toBe(true);
    expect(supportsWebSearch("gpt-3.5-turbo")).toBe(false);
  });
});

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("web search defaults", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
  });

  const webSearchEnabled = (options: OpenAIProviderOptions) =>
    new OpenAIProvider(noopLogger, validateInput, options).includeWebSearch;

  it("is on for the platform API and off for anything else", () => {
    expect(webSearchEnabled({})).toBe(true);
    expect(webSearchEnabled({ baseUrl: "http://localhost:1234/v1" })).toBe(
      false,
    );
    expect(webSearchEnabled({ authType: "bedrock" })).toBe(false);
    expect(webSearchEnabled({ includeWebSearch: false })).toBe(false);
  });
});

describe("schema compatibility", () => {
  it("drops unsupported format specifiers and leaves a description", () => {
    const sanitized = sanitizeSchemaForOpenAI({
      type: "object",
      properties: { u: { type: "string", format: "uri" } },
    } as never) as Record<string, never>;
    const prop = (
      sanitized.properties as Record<string, Record<string, unknown>>
    ).u;
    expect(prop.format).toBeUndefined();
    expect(prop.description).toBe("A valid URI string");
  });

  it("makes every property required and forbids additional properties", () => {
    const compatible = makeOpenAICompatible(tool("get_file"));
    const schema = compatible.input_schema as unknown as {
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toEqual(["path"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("does not mutate the original spec", () => {
    const spec = tool("get_file");
    makeOpenAICompatible(spec);
    expect(
      (spec.input_schema as unknown as { required?: unknown }).required,
    ).toBeUndefined();
  });
});

describe("createStreamParameters", () => {
  it("produces the request shape the codex backend requires", () => {
    const params = createStreamParameters({
      model: "gpt-5.4",
      messages: [userMessage("hi")],
      tools: [tool("get_file")],
      systemPrompt: "be terse",
    });

    expect(params.instructions).toBe("be terse");
    expect(params.store).toBe(false);
    expect(params.stream).toBe(true);
    // The codex backend rejects max_output_tokens outright.
    expect("max_output_tokens" in params).toBe(false);
    expect(params.include).toEqual(["reasoning.encrypted_content"]);
    expect(params.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
    ]);
  });

  it("only sends reasoning config to reasoning models", () => {
    const reasoning = {
      effort: "high" as const,
      summary: "detailed" as const,
    };
    expect(
      createStreamParameters({
        model: "gpt-5.4",
        messages: [userMessage("hi")],
        tools: [],
        reasoning,
      }).reasoning,
    ).toEqual({ effort: "high", summary: "detailed" });

    const nonReasoning = createStreamParameters({
      model: "gpt-4o",
      messages: [userMessage("hi")],
      tools: [],
      reasoning,
    });
    expect(nonReasoning.reasoning).toBeUndefined();
    expect(nonReasoning.include).toBeUndefined();
  });

  it("only adds web search when the model supports it and it is enabled", () => {
    const withSearch = createStreamParameters({
      model: "gpt-5.4",
      messages: [userMessage("hi")],
      tools: [],
      includeWebSearch: true,
    });
    expect(withSearch.tools).toEqual([{ type: "web_search" }]);

    expect(
      createStreamParameters({
        model: "gpt-5.4",
        messages: [userMessage("hi")],
        tools: [],
      }).tools,
    ).toEqual([]);

    expect(
      createStreamParameters({
        model: "gpt-3.5-turbo",
        messages: [userMessage("hi")],
        tools: [],
        includeWebSearch: true,
      }).tools,
    ).toEqual([]);
  });
});

describe("serialization determinism", () => {
  const base = {
    model: "gpt-5.4",
    tools: [tool("get_file"), tool("bash")],
    systemPrompt: "be terse",
  };

  it("serializes the same history identically twice", () => {
    const messages = [userMessage("one"), userMessage("two")];
    expect(JSON.stringify(createStreamParameters({ ...base, messages }))).toBe(
      JSON.stringify(createStreamParameters({ ...base, messages })),
    );
  });

  it("appending a message changes only the tail of the serialization", () => {
    const first = JSON.stringify(
      createStreamParameters({ ...base, messages: [userMessage("one")] }).input,
    );
    const second = JSON.stringify(
      createStreamParameters({
        ...base,
        messages: [userMessage("one"), userMessage("two")],
      }).input,
    );
    // The cached prefix is the leading input items; the shared prefix must
    // extend all the way to the end of the first request's items.
    expect(second.startsWith(first.slice(0, -1))).toBe(true);
  });

  it("orders tools independently of registration order", () => {
    const a = createStreamParameters({
      ...base,
      tools: [tool("get_file"), tool("bash")],
      messages: [userMessage("one")],
    });
    const b = createStreamParameters({
      ...base,
      tools: [tool("bash"), tool("get_file")],
      messages: [userMessage("one")],
    });
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    expect(a.tools?.map((t) => (t as { name: string }).name)).toEqual([
      "bash",
      "get_file",
    ]);
  });
});

describe("round-tripping server-generated content", () => {
  async function runTurn(drive: (stream: MockResponseStream) => void): Promise<{
    events: ProviderStreamEvent[];
    content: ProviderMessageContent[];
    nativeEventTypes: string[];
  }> {
    const client = new MockOpenAIClient();
    const stream = await client.responses.create({
      model: "gpt-5.4",
      input: [],
      stream: true,
    });
    drive(stream);
    stream.finishResponse("end_turn");

    const events: ProviderStreamEvent[] = [];
    const nativeEventTypes: string[] = [];
    for await (const event of stream) {
      nativeEventTypes.push(event.type);
      events.push(...mapResponseStreamEvent(event));
    }

    return {
      events,
      content: convertResponseOutputToProviderContent(
        validateInput,
        stream.getOutputItems(),
      ),
      nativeEventTypes,
    };
  }

  it("carries reasoning encrypted_content through to the next request", async () => {
    const { content, events } = await runTurn((s) => {
      s.streamReasoningSummary(["**Thinking**", "**More**"], {
        itemId: "rs_1",
        encryptedContent: "ENCRYPTED",
      });
      s.streamText("done", { itemId: "msg_1" });
    });

    // Many summary parts accumulate into one thinking block.
    const thinkingStarts = events.filter(
      (e) =>
        e.type === "content_block_start" && e.content_block.type === "thinking",
    );
    expect(thinkingStarts).toHaveLength(1);

    const thinking = content.find((c) => c.type === "thinking");
    expect(thinking).toMatchObject({
      signature: "ENCRYPTED",
      providerMetadata: { provider: "openai", itemId: "rs_1" },
    });

    const params = createStreamParameters({
      model: "gpt-5.4",
      messages: [userMessage("hi"), assistantMessage(content)],
      tools: [],
    });
    const reasoningItem = (
      params.input as unknown as Record<string, unknown>[]
    ).find((item) => item.type === "reasoning");
    expect(reasoningItem).toMatchObject({
      id: "rs_1",
      encrypted_content: "ENCRYPTED",
    });
  });

  it("keeps an empty-summary reasoning item and its encrypted content", async () => {
    const { content } = await runTurn((s) => {
      s.streamEmptyReasoning("ENC", "rs_empty");
      s.streamText("4");
    });

    const thinking = content.find((c) => c.type === "thinking");
    expect(thinking).toMatchObject({ thinking: "", signature: "ENC" });

    const params = createStreamParameters({
      model: "gpt-5.4",
      messages: [assistantMessage(content)],
      tools: [],
    });
    expect(
      (params.input as unknown as Record<string, unknown>[]).find(
        (item) => item.type === "reasoning",
      ),
    ).toMatchObject({ id: "rs_empty", encrypted_content: "ENC", summary: [] });
  });

  it("echoes web_search_call items and preserves annotations", async () => {
    const annotation: OpenAI.Responses.ResponseOutputText.URLCitation = {
      type: "url_citation",
      start_index: 0,
      end_index: 3,
      title: "Result",
      url: "https://example.com",
    };
    const { content } = await runTurn((s) => {
      s.streamWebSearchCall("who won", { itemId: "ws_1" });
      s.streamAnnotatedText("they did", [annotation]);
    });

    expect(content.find((c) => c.type === "server_tool_use")).toMatchObject({
      id: "ws_1",
      input: { query: "who won" },
    });
    const text = content.find((c) => c.type === "text");
    expect(text).toMatchObject({
      citations: [{ title: "Result", url: "https://example.com" }],
    });

    const params = createStreamParameters({
      model: "gpt-5.4",
      messages: [assistantMessage(content)],
      tools: [],
    });
    const items = params.input as unknown as Record<string, unknown>[];
    // Dropping the search item makes the model search again, so it must survive.
    expect(items.find((item) => item.type === "web_search_call")).toMatchObject(
      {
        id: "ws_1",
        action: { type: "search", query: "who won" },
      },
    );
    const message = items.find((item) => item.type === "message") as {
      content: { annotations: unknown[] }[];
    };
    expect(message.content[0].annotations).toHaveLength(1);
  });

  it("surfaces parallel tool calls as distinct blocks keyed by output_index", async () => {
    const { events, content } = await runTurn((s) => {
      s.streamToolCall("call_1", "get_file", { path: "a" });
      s.streamToolCall("call_2", "get_file", { path: "b" });
    });

    const starts = events.filter(
      (e) =>
        e.type === "content_block_start" && e.content_block.type === "tool_use",
    );
    expect(starts.map((e) => e.index)).toEqual([0, 1]);
    expect(content.filter((c) => c.type === "tool_use")).toHaveLength(2);
  });

  it("serializes a history whose reasoning items were dropped", () => {
    const content: ProviderMessageContent[] = [
      {
        type: "thinking",
        thinking: "orphan",
        signature: "",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
      {
        type: "text",
        text: "hello",
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ];

    const params = createStreamParameters({
      model: "gpt-5.4",
      messages: [assistantMessage(content)],
      tools: [],
    });
    const items = params.input as unknown as Record<string, unknown>[];
    // The backend tolerates missing reasoning items, so an id-less thinking
    // block is dropped rather than throwing.
    expect(items.some((item) => item.type === "reasoning")).toBe(false);
    expect(items).toHaveLength(1);
  });
});

describe("mock fidelity against captured fixtures", () => {
  async function nativeEventTypes(
    drive: (stream: MockResponseStream) => void,
  ): Promise<string[]> {
    const client = new MockOpenAIClient();
    const stream = await client.responses.create({
      model: "gpt-5.4",
      input: [],
      stream: true,
    });
    drive(stream);
    stream.finishResponse("end_turn");
    const types: string[] = [];
    for await (const event of stream) {
      types.push(event.type);
    }
    return types;
  }

  /** The captured turns are framed by created/in_progress; the mock only
   * emits the item-level events plus the terminal one. */
  const itemEvents = (types: string[]) =>
    types.filter(
      (t) => t !== "response.created" && t !== "response.in_progress",
    );

  it("emits the same event sequence as a captured text turn", async () => {
    const expected = itemEvents(fixtureEventTypes("text"));
    const actual = await nativeEventTypes((s) => s.streamText("Hi"));
    expect(dedupeDeltas(actual)).toEqual(dedupeDeltas(expected));
  });

  it("emits the same event sequence as a captured tool call", async () => {
    const expected = itemEvents(fixtureEventTypes("tool-call"));
    const actual = await nativeEventTypes((s) =>
      s.streamToolCall("call_1", "get_weather", { city: "Paris" }),
    );
    expect(dedupeDeltas(actual)).toEqual(dedupeDeltas(expected));
  });

  it("emits the same event sequence as a captured web search turn", async () => {
    const expected = itemEvents(fixtureEventTypes("web-search"));
    const actual = await nativeEventTypes((s) => {
      s.streamWebSearchCall("2026 Super Bowl winner");
      s.streamText("The Seahawks.");
    });
    expect(dedupeDeltas(actual)).toEqual(dedupeDeltas(expected));
  });

  it("emits the same event sequence as a captured empty-summary reasoning turn", async () => {
    const expected = itemEvents(fixtureEventTypes("reasoning-summary"));
    const actual = await nativeEventTypes((s) => {
      s.streamEmptyReasoning("ENC");
      s.streamText("5 cents.");
    });
    expect(dedupeDeltas(actual)).toEqual(dedupeDeltas(expected));
  });

  it("emits the same summary-part cycle as a captured multi-summary turn", async () => {
    const expected = itemEvents(fixtureEventTypes("reasoning-multi-summary"));
    const actual = await nativeEventTypes((s) => {
      s.streamReasoningSummary(["a", "b", "c"], { encryptedContent: "ENC" });
      s.streamText("done");
    });
    // Part counts differ, so compare the order in which each event type first
    // appears rather than the raw sequence.
    expect(firstAppearanceOrder(actual)).toEqual(
      firstAppearanceOrder(expected),
    );
  });

  it("leaves an aborted stream with no terminal event and no usage", async () => {
    const client = new MockOpenAIClient();
    const stream = await client.responses.create({
      model: "gpt-5.4",
      input: [],
      stream: true,
    });
    stream.streamText("partial");
    stream.abortMidstream();

    const types: string[] = [];
    for await (const event of stream) {
      types.push(event.type);
    }
    expect(types).not.toContain("response.completed");
  });
});

describe("tool results", () => {
  const toolResult = (value: ProviderToolResultContent[]): ProviderMessage => ({
    role: "user",
    content: [
      {
        type: "tool_result",
        id: "call_1" as ToolRequestId,
        result: {
          status: "ok",
          value,
          structuredResult: {
            status: "ok",
            value: "",
          } as unknown as ToolStructuredResult,
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ],
  });

  it("sends a text result as the function_call_output", () => {
    const params = createStreamParameters({
      model: "gpt-5.4",
      messages: [
        toolResult([
          {
            type: "text",
            text: "file contents",
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          },
        ]),
      ],
      tools: [],
    });
    expect(params.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "file contents",
      },
    ]);
  });

  it("sends an image-only result as a trailing user message with a non-empty output", () => {
    const params = createStreamParameters({
      model: "gpt-5.4",
      messages: [
        toolResult([
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "AAAA",
            },
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          },
        ]),
      ],
      tools: [],
    });
    const input = params.input as OpenAI.Responses.ResponseInput;
    expect(input[0]).toMatchObject({
      type: "function_call_output",
      output: "Attachment follows:",
    });
    expect(input[1]).toMatchObject({
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
      ],
    });
  });

  it("sends an error result as the function_call_output", () => {
    const params = createStreamParameters({
      model: "gpt-5.4",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              id: "call_1" as ToolRequestId,
              result: { status: "error", error: "boom" },
              nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
            },
          ],
        },
      ],
      tools: [],
    });
    expect(params.input).toEqual([
      { type: "function_call_output", call_id: "call_1", output: "boom" },
    ]);
  });
});

describe("reasoning item coalescing", () => {
  it("folds thinking blocks sharing an item id into one ordered reasoning item", () => {
    const thinkingBlock = (text: string): ProviderMessageContent => ({
      type: "thinking",
      thinking: text,
      signature: "ENCRYPTED",
      providerMetadata: { provider: "openai", itemId: "rs_1" },
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    });
    const params = createStreamParameters({
      model: "gpt-5.4",
      messages: [
        assistantMessage([
          thinkingBlock("first"),
          thinkingBlock("second"),
          thinkingBlock("third"),
        ]),
      ],
      tools: [],
    });
    const input = params.input as OpenAI.Responses.ResponseInput;
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "ENCRYPTED",
      summary: [
        { type: "summary_text", text: "first" },
        { type: "summary_text", text: "second" },
        { type: "summary_text", text: "third" },
      ],
    });
  });
});

describe("forceToolUse", () => {
  const spec = tool("get_files");

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let the SDK's stream reader drain and the request's microtasks settle. */
  async function tick(times = 6): Promise<void> {
    for (let i = 0; i < times; i++) {
      await vi.advanceTimersByTimeAsync(0);
    }
  }

  function setup(): {
    provider: OpenAIProvider;
    client: MockOpenAIClient;
  } {
    process.env.MAGENTA_TEST_OPENAI_KEY = "test-key";
    const provider = new OpenAIProvider(noopLogger, validateInput, {
      apiKeyEnvVar: "MAGENTA_TEST_OPENAI_KEY",
    });
    const client = new MockOpenAIClient();
    provider.client = client as unknown as OpenAI;
    return { provider, client };
  }

  const functionCall = (
    name: string,
    args: string,
  ): OpenAI.Responses.ResponseOutputItem => ({
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name,
    arguments: args,
    status: "completed",
  });

  const run = (provider: OpenAIProvider) =>
    provider.forceToolUse({
      model: "gpt-5.4",
      input: [],
      spec,
    });

  it("parses the function call and reports usage", async () => {
    const { provider, client } = setup();
    const request = run(provider);
    const stream = await client.awaitStreamAt(0);
    stream.finishResponseWithOutput(
      [
        functionCall(
          "get_files",
          JSON.stringify({ files: [{ filePath: "a" }] }),
        ),
      ],
      { inputTokens: 10, outputTokens: 2, cacheHits: 5 },
    );
    const result = await request.promise;

    expect(stream.params.stream).toBe(true);
    expect(stream.params.tool_choice).toEqual({
      type: "function",
      name: "get_files",
    });
    expect(result.stopReason).toBe("tool_use");
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cacheHits: 5,
    });
    expect(result.toolRequest.status).toBe("ok");
  });

  it("errors when the response has no function call", async () => {
    const { provider, client } = setup();
    const request = run(provider);
    (await client.awaitStreamAt(0)).finishResponseWithOutput([]);
    const result = await request.promise;
    expect(result.toolRequest.status).toBe("error");
    expect(result.toolRequest).toMatchObject({
      error: expect.stringContaining("get_files") as unknown as string,
    });
  });

  it("errors when the call names a different tool", async () => {
    const { provider, client } = setup();
    const request = run(provider);
    (await client.awaitStreamAt(0)).finishResponseWithOutput([
      functionCall("bash_command", "{}"),
    ]);
    const result = await request.promise;
    expect(result.toolRequest).toMatchObject({
      status: "error",
      error: expect.stringContaining("expected tool name") as unknown as string,
    });
  });

  it("errors on malformed argument JSON", async () => {
    const { provider, client } = setup();
    const request = run(provider);
    (await client.awaitStreamAt(0)).finishResponseWithOutput([
      functionCall("get_files", "{not json"),
    ]);
    const result = await request.promise;
    expect(result.toolRequest).toMatchObject({
      status: "error",
      rawRequest: "{not json",
    });
  });

  it("retries a retryable error and succeeds", async () => {
    const { provider, client } = setup();
    const request = run(provider);
    const first = await client.awaitStreamAt(0);
    first.respondWithError(
      new APIError(429, undefined, "rate limited", undefined),
    );
    await tick();

    await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] + 10);
    const retry = await client.awaitStreamAt(1);
    retry.finishResponseWithOutput([
      functionCall("get_files", JSON.stringify({ files: [{ filePath: "a" }] })),
    ]);
    const result = await request.promise;
    expect(result.stopReason).toBe("tool_use");
    expect(client.streams).toHaveLength(2);
  });

  it("does not retry a non-retryable error", async () => {
    const { provider, client } = setup();
    const request = run(provider);
    const settled = expect(request.promise).rejects.toThrow("bad request");
    (await client.awaitStreamAt(0)).respondWithError(
      new APIError(400, undefined, "bad request", undefined),
    );
    await settled;
    expect(client.streams).toHaveLength(1);
  });

  it("surfaces the original error when aborted during the retry delay", async () => {
    const { provider, client } = setup();
    const request = run(provider);
    const settled = expect(request.promise).rejects.toThrow("rate limited");
    (await client.awaitStreamAt(0)).respondWithError(
      new APIError(429, undefined, "rate limited", undefined),
    );
    await tick();
    request.abort();
    await settled;
    expect(client.streams).toHaveLength(1);
  });
});

/** Delta counts differ between a real stream and the mock's single chunk, so
 * compare shapes with runs of identical delta events collapsed. */
function dedupeDeltas(types: string[]): string[] {
  return types.filter((t, i) => !(t.endsWith(".delta") && types[i - 1] === t));
}

/** Order in which each distinct event type first appears. */
function firstAppearanceOrder(types: string[]): string[] {
  return [...new Set(types)];
}
