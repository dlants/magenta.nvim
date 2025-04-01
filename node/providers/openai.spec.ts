import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenAIProvider } from "./openai.ts";
import type { Nvim } from "nvim-node";
import type { ProviderMessage } from "./provider-types.ts";
import { withDriver } from "../test/preamble.ts";

vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    })),
  };
});

describe("openai.ts", () => {
  let mockNvim: Nvim;
  let messages: ProviderMessage[];

  beforeEach(() => {
    mockNvim = { logger: { debug: vi.fn() } } as unknown as Nvim;
    process.env.OPENAI_API_KEY = "test-key";

    messages = [
      {
        role: "user",
        content: "Hello world",
      },
    ];
  });

  it("should set parallel_tool_calls to false when omitParallelToolCalls is false", () => {
    const provider = new OpenAIProvider(mockNvim, {
      model: "gpt-4",
      omitParallelToolCalls: false,
    });

    const params = provider.createStreamParameters(messages);

    expect(params.parallel_tool_calls).toBe(false);
  });

  it("should not include parallel_tool_calls when omitParallelToolCalls is true", () => {
    const provider = new OpenAIProvider(mockNvim, {
      model: "gpt-4",
      omitParallelToolCalls: true,
    });

    const params = provider.createStreamParameters(messages);

    expect(params.parallel_tool_calls).toBeUndefined();
  });

  it("paralell_tool_calls should be included by default and set to false", () => {
    const provider = new OpenAIProvider(mockNvim, {
      model: "gpt-4",
    });

    const params = provider.createStreamParameters(messages);

    expect(params).toHaveProperty("parallel_tool_calls");
    expect(params.parallel_tool_calls).toBe(false);
  });

  it("should correctly set parallel_tool_calls when switching between two openai models", async () => {
    await withDriver(async (driver) => {
      await driver.nvim.call("nvim_command", [
        "Magenta provider openai gpt-4o",
      ]);
      let state = driver.magenta.chatApp.getState();
      if (state.status != "running") {
        throw new Error(`Expected state to be running`);
      }
      expect(state.model.providerSetting).toEqual({
        provider: "openai",
        model: "gpt-4o",
        omitParallelToolCalls: false,
      });

      await driver.nvim.call("nvim_command", [
        "Magenta provider openai o1 omit_parallel_tool_calls",
      ]);
      state = driver.magenta.chatApp.getState();
      if (state.status != "running") {
        throw new Error(`Expected state to be running`);
      }
      expect(state.model.providerSetting).toEqual({
        provider: "openai",
        model: "o1",
        omitParallelToolCalls: true,
      });
    });
  });
});
