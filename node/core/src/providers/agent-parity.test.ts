import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { Logger } from "../logger.ts";
import { validateInput } from "../tools/helpers.ts";
import { AnthropicAgent } from "./anthropic-agent.ts";
import { MockAnthropicClient } from "./mock-anthropic-client.ts";
import { MockOpenAIClient } from "./mock-openai-client.ts";
import { OpenAIAgent, type OpenAIStreamingClient } from "./openai-agent.ts";
import {
  type AgentInput,
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderToolSpec,
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

function anthropicContent() {
  const agent = new AnthropicAgent(
    {
      ...sharedOptions,
      model: "claude-sonnet-4-20250514",
      skipPostFlightTokenCount: true,
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
  agent.appendUserMessage(input);
  return agent.getState().messages;
}

function openaiContent() {
  const agent = new OpenAIAgent(
    { ...sharedOptions, model: "gpt-5.4" },
    new MockOpenAIClient() as unknown as OpenAIStreamingClient,
    { includeWebSearch: false, logger: noopLogger, validateInput },
  );
  agent.appendUserMessage(input);
  return agent.getState().messages;
}

describe("agent parity for tagged user input", () => {
  it("produces identical provider content across anthropic and openai agents", () => {
    const anthropic = anthropicContent();
    const openai = openaiContent();

    expect(anthropic).toHaveLength(1);
    expect(openai).toHaveLength(1);
    expect(anthropic[0].role).toBe("user");
    expect(openai[0].role).toBe("user");
    expect(openai[0].content).toEqual(anthropic[0].content);
  });

  it("re-tags each structured item with its discriminated type", () => {
    for (const messages of [anthropicContent(), openaiContent()]) {
      expect(messages[0].content.map((c) => c.type)).toEqual(expectedTypes);
    }
  });
});
