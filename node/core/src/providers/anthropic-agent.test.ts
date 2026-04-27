import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { validateInput } from "../tools/helpers.ts";
import {
  convertAnthropicMessagesToProvider,
  getContextWindowForModel,
  getMaxTokensForModel,
} from "./anthropic-agent.ts";

describe("getMaxTokensForModel", () => {
  it("should handle standard claude model strings", () => {
    expect(getMaxTokensForModel("claude-3-5-sonnet-20241022")).toBe(8192);
    expect(getMaxTokensForModel("claude-3-7-sonnet-20250219")).toBe(32000);
    expect(getMaxTokensForModel("claude-sonnet-4-20250514")).toBe(32000);
    expect(getMaxTokensForModel("claude-opus-4-6-20250605")).toBe(32000);
    expect(getMaxTokensForModel("claude-sonnet-4-5-20250514")).toBe(32000);
  });

  it("should handle Bedrock model strings", () => {
    expect(
      getMaxTokensForModel("us.anthropic.claude-3-5-sonnet-20241022-v2:0"),
    ).toBe(8192);
    expect(getMaxTokensForModel("us.anthropic.claude-opus-4-6-v1:0")).toBe(
      32000,
    );
    expect(
      getMaxTokensForModel("global.anthropic.claude-sonnet-4-5-20250514-v1:0"),
    ).toBe(32000);
  });

  it("should return default for unknown models", () => {
    expect(getMaxTokensForModel("gpt-4")).toBe(4096);
  });
});

describe("convertAnthropicMessagesToProvider system reminder detection", () => {
  it("converts a text block containing a single combined <system-reminder> into one system_reminder content block", () => {
    const combined = `<system-reminder>
First reminder body
Second reminder body
</system-reminder>`;
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: [{ type: "text", text: combined }],
      },
    ];

    const result = convertAnthropicMessagesToProvider(validateInput, messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(1);
    const block = result[0].content[0];
    expect(block.type).toBe("system_reminder");
    if (block.type !== "system_reminder") throw new Error("type narrow");
    expect(block.text).toBe(combined);
  });
});

describe("getContextWindowForModel", () => {
  it("should handle standard claude model strings", () => {
    expect(getContextWindowForModel("claude-3-5-sonnet-20241022")).toBe(
      200_000,
    );
  });

  it("should handle Bedrock model strings", () => {
    expect(
      getContextWindowForModel("us.anthropic.claude-3-5-sonnet-20241022-v2:0"),
    ).toBe(200_000);
  });

  it("should handle legacy Claude 2.x models", () => {
    expect(getContextWindowForModel("claude-2.1")).toBe(100_000);
  });
});
