import { describe, expect, it } from "vitest";
import type { Agent } from "../agent.ts";
import {
  agentHooks,
  createTestAgent,
  createTestOpenAIAgent,
  flatPhase,
} from "../test-helpers.ts";
import type { BeforeRequestHook, SendResult } from "../thread-api.ts";
import {
  AutoCompactSupervisor,
  composeSupervisors,
} from "../thread-supervisor.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { pollUntil } from "../utils/async.ts";
import { ABORT_MARKER_TEXT } from "./inference-shared.ts";
import {
  type AgentInput,
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderMessage,
} from "./provider-types.ts";

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
 * still in flight so the user message is visible before any cleanup.
 *
 * Both sides are driven by the one loop in `Agent`, so this compares two
 * managers under one driver rather than two drivers. */
type TurnSnapshot = {
  messages: ProviderMessage[];
  phaseDuringTurn: string;
  phaseAfterTurn: string;
  turnResult: SendResult;
  executorCalls: number;
};

async function anthropicContent(): Promise<TurnSnapshot> {
  let executorCalls = 0;
  const { agent, mockClient } = createTestAgent({
    executeTools: () => {
      executorCalls++;
      return noExecutor();
    },
  });
  // The tagged input is richer than a submission can carry (a submission is
  // text only), so it is appended the way a hook's injection would be, and
  // the turn is then driven with nothing of its own to add.
  agent.manager.appendUserMessage(input);
  const turn = agent.send();
  const stream = await mockClient.awaitStream();
  const phaseDuringTurn = flatPhase(agent).type;
  const messages = snapshot(agent.getProviderMessages());
  stream.finishResponse("end_turn", { inputTokens: 1, outputTokens: 1 });
  const turnResult = await turn;
  return {
    messages,
    phaseDuringTurn,
    phaseAfterTurn: flatPhase(agent).type,
    turnResult,
    executorCalls,
  };
}

async function openaiContent(): Promise<TurnSnapshot> {
  let executorCalls = 0;
  const { agent, mockClient } = createTestOpenAIAgent({
    executeTools: () => {
      executorCalls++;
      return noExecutor();
    },
  });
  agent.manager.appendUserMessage(input);
  const turn = agent.send();
  const stream = await mockClient.awaitStream();
  const phaseDuringTurn = flatPhase(agent).type;
  const messages = snapshot(agent.manager.log.messages);
  stream.finishResponse("end_turn", { inputTokens: 1, outputTokens: 1 });
  const turnResult = await turn;
  return {
    messages,
    phaseDuringTurn,
    phaseAfterTurn: flatPhase(agent).type,
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
        type: "completed",
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
  /** The gate fires on the opening request too; this one holds the
   * continuation that would carry the tool results. */
  const holdSecond = (bump: () => number): BeforeRequestHook => ({
    run: () =>
      Promise.resolve(
        bump() === 1
          ? { type: "none" as const }
          : { type: "suspend" as const, reason: held },
      ),
  });

  it("stops the anthropic turn without issuing the continuation", async () => {
    let calls = 0;
    const { agent, mockClient } = createTestAgent({
      getHooks: () =>
        agentHooks({ onBeforeRequest: [holdSecond(() => ++calls)] }),
    });
    const sendPromise = agent.send([{ type: "user", text: "go" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("tool-1" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/a.txt" }],
    });
    stream.finishResponse("tool_use", { inputTokens: 1, outputTokens: 1 });
    const result = await sendPromise;
    expect(result).toEqual({ type: "suspended", reason: held });
    expect(calls).toBe(2);
    expect(mockClient.streams).toHaveLength(1);
  });

  it("stops the openai turn without issuing the continuation", async () => {
    let calls = 0;
    const { agent, mockClient } = createTestOpenAIAgent({
      executeTools: emptyResults,
      getHooks: () =>
        agentHooks({ onBeforeRequest: [holdSecond(() => ++calls)] }),
    });
    const sendPromise = agent.send([{ type: "user", text: "go" }]);
    const stream = await mockClient.awaitStream();
    stream.streamToolCall("tool-1", "get_files", {
      files: [{ filePath: "/tmp/a.txt" }],
    });
    stream.finishResponse("end_turn", { inputTokens: 1, outputTokens: 1 });
    const result = await sendPromise;
    expect(result).toEqual({ type: "suspended", reason: held });
    expect(calls).toBe(2);
    expect(mockClient.streams).toHaveLength(1);
  });
});

describe("abort parity", () => {
  /** An abort landing mid-stream unwinds the same way on both sides: one
   * `aborted` result, an idle phase, and a well-formed history whose last
   * message is the abort marker. */
  async function abortMidStream(
    start: () => { agent: Agent; abortStream: () => void },
  ) {
    const { agent, abortStream } = start();
    const turn = agent.send([{ type: "user", text: "go" }]);
    await pollUntil(() => {
      if (flatPhase(agent).type !== "streaming")
        throw new Error("not streaming");
      return true;
    });
    agent.abort();
    abortStream();
    const result = await turn;
    const messages = agent.manager.log.messages;
    const last = messages[messages.length - 1];
    return {
      result,
      phaseAfterTurn: flatPhase(agent).type,
      lastRole: last.role,
      lastText: JSON.stringify(last.content),
    };
  }

  it("unwinds identically across anthropic and openai", async () => {
    const anthropic = await abortMidStream(() => {
      const { agent, mockClient } = createTestAgent();
      return {
        agent,
        abortStream: () =>
          mockClient.streams[mockClient.streams.length - 1]?.abort(),
      };
    });
    const openai = await abortMidStream(() => {
      const { agent, mockClient } = createTestOpenAIAgent();
      return {
        agent,
        abortStream: () =>
          mockClient.streams[mockClient.streams.length - 1]?.abortMidstream(),
      };
    });

    for (const snap of [anthropic, openai]) {
      expect(snap.result).toEqual({ type: "aborted" });
      expect(snap.phaseAfterTurn).toBe("idle");
      expect(snap.lastRole).toBe("user");
      expect(snap.lastText).toContain(ABORT_MARKER_TEXT);
    }
  });
});

describe("preflight token count parity", () => {
  /** The count is provider-specific: only the anthropic manager implements
   * `countTokens`. On openai a hook that asks for one sees `undefined`, so
   * `AutoCompactSupervisor` cannot fire — auto-compaction is an
   * anthropic-only feature until openai grows a counting endpoint. */
  const compactHooks = () =>
    agentHooks({
      onBeforeRequest: composeSupervisors(() => [
        new AutoCompactSupervisor({ nextPrompt: "wrap up", threshold: 1 }),
      ]).onBeforeRequest,
    });
  it("suspends for compaction on anthropic and not on openai", async () => {
    const { agent, mockClient } = createTestAgent({
      getHooks: compactHooks,
      executeTools: noExecutor,
    });
    mockClient.mockInputTokenCount = 100;
    expect(await agent.send([{ type: "user", text: "go" }])).toEqual({
      type: "suspended",
      reason: { kind: "compact", nextPrompt: "wrap up" },
    });

    const openai = createTestOpenAIAgent({
      getHooks: compactHooks,
      executeTools: noExecutor,
    });
    const sendPromise = openai.agent.send([{ type: "user", text: "go" }]);
    const stream = await openai.mockClient.awaitStream();
    stream.finishResponse("end_turn", { inputTokens: 100, outputTokens: 1 });
    expect(await sendPromise).toEqual({
      type: "completed",
      stopReason: "end_turn",
    });
  });
});
describe("appendUserMessage coalescing", () => {
  const makeAnthropic = () => createTestAgent().agent.manager;
  const makeOpenAI = () => createTestOpenAIAgent().agent.manager;

  it.each([
    ["anthropic", makeAnthropic],
    ["openai", makeOpenAI],
  ])("%s folds a coalescing append into the trailing user message", (_name, make) => {
    const runner = make();
    runner.appendUserMessage([text("first")]);
    runner.appendUserMessage([text("second")]);
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
    runner.appendUserMessage([text("only")]);
    const messages = runner.log.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(JSON.stringify(messages[0].content)).toContain("only");
  });
});
