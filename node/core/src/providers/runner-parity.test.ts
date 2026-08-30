import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { Logger } from "../logger.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { validateInput } from "../tools/helpers.ts";
import { AnthropicRunner } from "./anthropic-runner.ts";
import { MockAnthropicClient } from "./mock-anthropic-client.ts";
import { MockOpenAIClient } from "./mock-openai-client.ts";
import { OpenAIRunner, type OpenAIStreamingClient } from "./openai-runner.ts";
import {
  type AgentInput,
  type AgentPhase,
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderMessage,
  type ProviderToolSpec,
  type TurnResult,
} from "./provider-types.ts";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const sharedOptions = {
  systemPrompt: "be helpful",
  tools: [] as ProviderToolSpec[],
};

function text(text: string): AgentInput {
  return {
    type: "text",
    text,
    nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
  };
}

const input: AgentInput[] = [
  text("plain user text"),
  text("I see <context_update> and <system-reminder> rendered as plain text"),
  text("<system-reminder>remember this</system-reminder>"),
  text("<system-info>os: darwin</system-info>"),
  text("<context_update>file changed</context_update>"),
  text("<fork-notification>forked</fork-notification>"),
  {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "abc123" },
    nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
  },
];

const expectedTypes = [
  "text",
  "text",
  "system_reminder",
  "system_info",
  "context_update",
  "fork_notification",
  "image",
];

const noExecutor = () => {
  throw new Error("executeTools should not be called: no tools are configured");
};

/** Snapshot of what a single opening request produced, taken while the turn is
 * still in flight so the user message is visible before any cleanup. */
type TurnSnapshot = {
  messages: ProviderMessage[];
  phaseDuringTurn: AgentPhase["type"];
  phaseAfterTurn: AgentPhase["type"];
  turnResult: TurnResult;
  executorCalls: number;
};

async function anthropicContent(): Promise<TurnSnapshot> {
  const client = new MockAnthropicClient();
  let executorCalls = 0;
  const agent = new AnthropicRunner(
    {
      ...sharedOptions,
      model: "claude-sonnet-4-20250514",
      skipPostFlightTokenCount: true,
      executeTools: () => {
        executorCalls++;
        return noExecutor();
      },
      onUpdate: () => {},
    },
    client as unknown as Anthropic,
    {
      authType: "key",
      includeWebSearch: false,
      disableParallelToolUseFlag: true,
      logger: noopLogger,
      validateInput,
    },
  );
  const turn = agent.runTurn(input);
  const stream = await client.awaitStream();
  const phaseDuringTurn = agent.phase.type;
  const messages = snapshot(agent.log.messages);
  stream.finishResponse("end_turn", { inputTokens: 1, outputTokens: 1 });
  const turnResult = await turn;
  return {
    messages,
    phaseDuringTurn,
    phaseAfterTurn: agent.phase.type,
    turnResult,
    executorCalls,
  };
}

async function openaiContent(): Promise<TurnSnapshot> {
  const client = new MockOpenAIClient();
  let executorCalls = 0;
  const agent = new OpenAIRunner(
    {
      ...sharedOptions,
      model: "gpt-5.4",
      executeTools: () => {
        executorCalls++;
        return noExecutor();
      },
      onUpdate: () => {},
    },
    client as unknown as OpenAIStreamingClient,
    { includeWebSearch: false, logger: noopLogger, validateInput },
  );
  const turn = agent.runTurn(input);
  const stream = await client.awaitStream();
  const phaseDuringTurn = agent.phase.type;
  const messages = snapshot(agent.log.messages);
  stream.finishResponse("end_turn", { inputTokens: 1, outputTokens: 1 });
  const turnResult = await turn;
  return {
    messages,
    phaseDuringTurn,
    phaseAfterTurn: agent.phase.type,
    turnResult,
    executorCalls,
  };
}

function snapshot(messages: ReadonlyArray<ProviderMessage>): ProviderMessage[] {
  return messages.map((m) => ({ ...m, content: [...m.content] }));
}

describe("agent parity for tagged user input", () => {
  it("produces identical provider content across anthropic and openai agents", async () => {
    const anthropic = (await anthropicContent()).messages;
    const openai = (await openaiContent()).messages;

    expect(anthropic).toHaveLength(1);
    expect(openai).toHaveLength(1);
    expect(anthropic[0].role).toBe("user");
    expect(openai[0].role).toBe("user");
    expect(openai[0].content).toEqual(anthropic[0].content);
  });

  it("passes through the same phases and executor calls", async () => {
    const anthropic = await anthropicContent();
    const openai = await openaiContent();

    for (const snap of [anthropic, openai]) {
      expect(snap.phaseDuringTurn).toBe("streaming");
      expect(snap.phaseAfterTurn).toBe("idle");
      expect(snap.turnResult).toEqual({
        type: "stopped",
        stopReason: "end_turn",
      });
      expect(snap.executorCalls).toBe(0);
    }
  });

  it("re-tags each structured item with its discriminated type", async () => {
    for (const { messages } of [
      await anthropicContent(),
      await openaiContent(),
    ]) {
      expect(messages[0].content.map((c) => c.type)).toEqual(expectedTypes);
    }
  });
});

describe("onBeforeRequest", () => {
  /** The runner fills a result for every requested tool it isn't handed. */
  const emptyResults = () =>
    Promise.resolve({ type: "continue" as const, results: new Map() });

  const held = { kind: "stop" as const, message: "held" };

  it("stops the anthropic turn without issuing the continuation", async () => {
    const client = new MockAnthropicClient();
    let calls = 0;
    const runner = new AnthropicRunner(
      {
        ...sharedOptions,
        model: "claude-sonnet-4-20250514",
        skipPostFlightTokenCount: true,
        executeTools: emptyResults,
        onUpdate: () => {},
        onBeforeRequest: () => {
          calls++;
          // The gate fires on the opening request too; this one holds the
          // continuation that would carry the tool results.
          return Promise.resolve(
            calls === 1
              ? { type: "proceed" as const }
              : { type: "suspend" as const, reason: held },
          );
        },
      },
      client as unknown as Anthropic,
      {
        authType: "key",
        includeWebSearch: false,
        disableParallelToolUseFlag: true,
        logger: noopLogger,
        validateInput,
      },
    );
    const turn = runner.runTurn([text("go")]);
    const stream = await client.awaitStream();
    stream.streamToolUse("tool-1" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/a.txt" }],
    });
    stream.finishResponse("tool_use", { inputTokens: 1, outputTokens: 1 });
    expect(await turn).toEqual({ type: "suspended", reason: held });
    expect(calls).toBe(2);
    expect(client.streams).toHaveLength(1);
  });

  it("stops the openai turn without issuing the continuation", async () => {
    const client = new MockOpenAIClient();
    let calls = 0;
    const runner = new OpenAIRunner(
      {
        ...sharedOptions,
        model: "gpt-5.4",
        executeTools: emptyResults,
        onUpdate: () => {},
        onBeforeRequest: () => {
          calls++;
          // The gate fires on the opening request too; this one holds the
          // continuation that would carry the tool results.
          return Promise.resolve(
            calls === 1
              ? { type: "proceed" as const }
              : { type: "suspend" as const, reason: held },
          );
        },
      },
      client as unknown as OpenAIStreamingClient,
      { includeWebSearch: false, logger: noopLogger, validateInput },
    );
    const turn = runner.runTurn([text("go")]);
    const stream = await client.awaitStream();
    stream.streamToolCall("tool-1", "get_files", {
      files: [{ filePath: "/tmp/a.txt" }],
    });
    stream.finishResponse("end_turn", { inputTokens: 1, outputTokens: 1 });
    expect(await turn).toEqual({ type: "suspended", reason: held });
    expect(calls).toBe(2);
    expect(client.streams).toHaveLength(1);
  });
});

describe("appendUserMessage coalescing", () => {
  const makeAnthropic = () =>
    new AnthropicRunner(
      {
        ...sharedOptions,
        model: "claude-sonnet-4-20250514",
        skipPostFlightTokenCount: true,
        executeTools: noExecutor,
        onUpdate: () => {},
      },
      new MockAnthropicClient() as unknown as Anthropic,
      {
        authType: "key",
        includeWebSearch: false,
        disableParallelToolUseFlag: true,
        logger: noopLogger,
        validateInput,
      },
    );

  const makeOpenAI = () =>
    new OpenAIRunner(
      {
        ...sharedOptions,
        model: "gpt-5.4",
        executeTools: noExecutor,
        onUpdate: () => {},
      },
      new MockOpenAIClient() as unknown as OpenAIStreamingClient,
      { includeWebSearch: false, logger: noopLogger, validateInput },
    );

  it.each([
    ["anthropic", makeAnthropic],
    ["openai", makeOpenAI],
  ])("%s folds a coalescing append into the trailing user message", (_name, make) => {
    const runner = make();
    runner.appendUserMessage([text("first")]);
    runner.appendUserMessage([text("second")], { coalesce: true });
    const messages = runner.log.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(JSON.stringify(messages[0].content)).toContain("first");
    expect(JSON.stringify(messages[0].content)).toContain("second");
  });
  it.each([
    ["anthropic", makeAnthropic],
    ["openai", makeOpenAI],
  ])("%s pushes a new user message when there is nothing to fold into", (_name, make) => {
    const runner = make();
    runner.appendUserMessage([text("only")], { coalesce: true });
    const messages = runner.log.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(JSON.stringify(messages[0].content)).toContain("only");
  });
});
