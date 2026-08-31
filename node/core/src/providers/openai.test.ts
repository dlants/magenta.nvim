import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type OpenAI from "openai";
import { APIError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolName } from "../tool-types.ts";
import { validateInput } from "../tools/helpers.ts";
import { RETRY_DELAYS } from "./inference-shared.ts";
import {
  MockOpenAIClient,
  type MockResponseStream,
} from "./mock-openai-client.ts";
import {
  convertInputToNativeItems,
  createStreamParameters,
  isReasoningModel,
  makeOpenAICompatible,
  OpenAIProvider,
  type OpenAIProviderOptions,
  sanitizeSchemaForOpenAI,
  supportsWebSearch,
} from "./openai.ts";
import {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
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

function userItem(text: string): OpenAI.Responses.ResponseInputItem {
  return convertInputToNativeItems([
    { type: "text", text, nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX },
  ])[0] as OpenAI.Responses.ResponseInputItem;
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
      input: [userItem("hi")],
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
        input: [userItem("hi")],
        tools: [],
        reasoning,
      }).reasoning,
    ).toEqual({ effort: "high", summary: "detailed" });

    const nonReasoning = createStreamParameters({
      model: "gpt-4o",
      input: [userItem("hi")],
      tools: [],
      reasoning,
    });
    expect(nonReasoning.reasoning).toBeUndefined();
    expect(nonReasoning.include).toBeUndefined();
  });

  it("only adds web search when the model supports it and it is enabled", () => {
    const withSearch = createStreamParameters({
      model: "gpt-5.4",
      input: [userItem("hi")],
      tools: [],
      includeWebSearch: true,
    });
    expect(withSearch.tools).toEqual([{ type: "web_search" }]);

    expect(
      createStreamParameters({
        model: "gpt-5.4",
        input: [userItem("hi")],
        tools: [],
      }).tools,
    ).toEqual([]);

    expect(
      createStreamParameters({
        model: "gpt-3.5-turbo",
        input: [userItem("hi")],
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
    const input = [userItem("one"), userItem("two")];
    expect(JSON.stringify(createStreamParameters({ ...base, input }))).toBe(
      JSON.stringify(createStreamParameters({ ...base, input })),
    );
  });

  it("appending a message changes only the tail of the serialization", () => {
    const first = JSON.stringify(
      createStreamParameters({ ...base, input: [userItem("one")] }).input,
    );
    const second = JSON.stringify(
      createStreamParameters({
        ...base,
        input: [userItem("one"), userItem("two")],
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
      input: [userItem("one")],
    });
    const b = createStreamParameters({
      ...base,
      tools: [tool("bash"), tool("get_file")],
      input: [userItem("one")],
    });
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    expect(a.tools?.map((t) => (t as { name: string }).name)).toEqual([
      "bash",
      "get_file",
    ]);
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
