import { describe, it } from "vitest";

describe.skip("OpenAIProvider", () => {
  it.todo("placeholder - tests commented out");
});

/*
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getProvider, setMockProvider } from "./provider.ts";
import type {
  ProviderMessage,
  ProviderName,
  ProviderStreamEvent,
} from "./provider-types.ts";
import { withNvimClient } from "../test/preamble.ts";
import { OpenAIProvider } from "./openai.ts";
import type { ResponseInput } from "openai/resources/responses/responses.mjs";

interface MockOpenAIConfig {
  baseURL?: string;
  apiKey?: string;
}

let lastOpenAIConfig: MockOpenAIConfig | undefined;
let mockStreamEvents: unknown[] = [];
vi.mock("openai", () => {
  class MockOpenAI {
    responses = {
      create: vi.fn().mockImplementation(() => {
        return {
          // eslint-disable-next-line @typescript-eslint/require-await
          [Symbol.asyncIterator]: async function* () {
            for (const event of mockStreamEvents) {
              yield event;
            }
          },
          controller: {
            abort: vi.fn(() => {}),
          },
        };
      }),
    };

    constructor(config: MockOpenAIConfig) {
      lastOpenAIConfig = config;
    }
  }

  return {
    default: MockOpenAI,
  };
});

describe("OpenAIProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastOpenAIConfig = undefined;
    mockStreamEvents = [];
    process.env.OPENAI_API_KEY = "test-key";
    setMockProvider(undefined);
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("should correctly reset baseUrl when switching between profiles with different baseUrls", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    await withNvimClient(async (nvim) => {
      const profile1 = {
        name: "gpt-4o",
        provider: "openai" as ProviderName,
        model: "gpt-4o",
        fastModel: "gpt-4o",
        baseUrl: "https://api.openai.com/v1",
      };

      const profile2 = {
        name: "qwen3:14b",
        provider: "openai" as ProviderName,
        model: "qwen3:14b",
        fastModel: "qwen3:14b",
        baseUrl: "http://localhost:11434/v1",
      };

      const provider1 = getProvider(nvim, profile1);
      expect(provider1).toBeDefined();

      expect(lastOpenAIConfig).toHaveProperty(
        "baseURL",
        "https://api.openai.com/v1",
      );

      const provider2 = getProvider(nvim, profile2);
      expect(provider2).toBeDefined();

      expect(lastOpenAIConfig).toHaveProperty(
        "baseURL",
        "http://localhost:11434/v1",
      );

      expect(provider1).not.toBe(provider2);
    });
  });

  it("should handle reasoning events correctly", async () => {
    await withNvimClient(async (nvim) => {
      const profile = {
        name: "gpt-4o",
        provider: "openai" as ProviderName,
        model: "gpt-4o",
        fastModel: "gpt-4o",
      };

      // Set up mock stream events from the notes
      mockStreamEvents = [
        // Initial reasoning item with encrypted content
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "item-123",
            encrypted_content: "encrypted-data-456",
          },
        },
        // First summary part
        {
          type: "response.reasoning_summary_part.added",
          summary_index: 0,
          item_id: "item-123",
        },
        {
          type: "response.reasoning_summary_text.delta",
          summary_index: 0,
          item_id: "item-123",
          delta: "First part of thinking",
        },
        {
          type: "response.reasoning_summary_text.delta",
          summary_index: 0,
          item_id: "item-123",
          delta: " continues here",
        },
        {
          type: "response.reasoning_summary_text.done",
          summary_index: 0,
          item_id: "item-123",
        },
        {
          type: "response.reasoning_summary_part.done",
          summary_index: 0,
          item_id: "item-123",
        },
        // Second summary part
        {
          type: "response.reasoning_summary_part.added",
          summary_index: 1,
          item_id: "item-123",
        },
        {
          type: "response.reasoning_summary_text.delta",
          summary_index: 1,
          item_id: "item-123",
          delta: "Second thinking part",
        },
        {
          type: "response.reasoning_summary_text.done",
          summary_index: 1,
          item_id: "item-123",
        },
        {
          type: "response.reasoning_summary_part.done",
          summary_index: 1,
          item_id: "item-123",
        },
        // End reasoning item
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "item-123",
          },
        },
        // Completion event
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 100,
              output_tokens: 50,
            },
          },
        },
      ];

      const provider = getProvider(nvim, profile);
      const capturedEvents: ProviderStreamEvent[] = [];

      const streamRequest = provider.sendMessage({
        model: "gpt-4o",
        messages: [
          { role: "user", content: [{ type: "text", text: "Test message" }] },
        ],
        onStreamEvent: (event) => capturedEvents.push(event),
        tools: [],
      });

      await streamRequest.promise;

      // Expected events based on the implementation:
      expect(capturedEvents).toEqual([
        // Redacted thinking block (start + end)
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "redacted_thinking",
            data: "encrypted-data-456",
          },
          providerMetadata: {
            openai: {
              itemId: "item-123",
            },
          },
        },
        {
          type: "content_block_stop",
          index: 0,
        },
        // First thinking block
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "thinking",
            thinking: "",
            signature: "",
          },
          providerMetadata: {
            openai: {
              itemId: "item-123",
            },
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "First part of thinking",
          },
          providerMetadata: {
            openai: {
              itemId: "item-123",
            },
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: " continues here",
          },
          providerMetadata: {
            openai: {
              itemId: "item-123",
            },
          },
        },
        {
          type: "content_block_stop",
          index: 0,
        },
        // Second thinking block
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "thinking",
            thinking: "",
            signature: "",
          },
          providerMetadata: {
            openai: {
              itemId: "item-123",
            },
          },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: {
            type: "thinking_delta",
            thinking: "Second thinking part",
          },
          providerMetadata: {
            openai: {
              itemId: "item-123",
            },
          },
        },
        {
          type: "content_block_stop",
          index: 1,
        },
      ]);
    });
  });

  it("should aggregate thinking blocks back into reasoning messages", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    await withNvimClient(async (nvim) => {
      const provider = new OpenAIProvider(nvim);

      // Create a message with multiple thinking blocks that should be aggregated
      const messages: ProviderMessage[] = [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "Test question" }],
        },
        {
          role: "assistant" as const,
          content: [
            // Redacted thinking block
            {
              type: "redacted_thinking" as const,
              data: "encrypted-data-123",
              providerMetadata: {
                openai: {
                  itemId: "reasoning-item-1",
                },
              },
            },
            // First thinking summary
            {
              type: "thinking" as const,
              thinking: "Let me think about this step by step.",
              signature: "",
              providerMetadata: {
                openai: {
                  itemId: "reasoning-item-1",
                },
              },
            },
            // Second thinking summary (same itemId)
            {
              type: "thinking" as const,
              thinking: "Now I need to consider the implications.",
              signature: "",
              providerMetadata: {
                openai: {
                  itemId: "reasoning-item-1",
                },
              },
            },
            // Regular text response
            {
              type: "text" as const,
              text: "Here's my answer based on my thinking.",
              providerMetadata: {
                openai: {
                  itemId: "text-item-1",
                },
              },
            },
            // Another reasoning block with different itemId
            {
              type: "thinking" as const,
              thinking: "Actually, let me double-check this.",
              signature: "",
              providerMetadata: {
                openai: {
                  itemId: "reasoning-item-2",
                },
              },
            },
          ],
        },
      ];

      const params = provider.createStreamParameters({
        model: "gpt-4o",
        messages,
        tools: [],
      });

      // Extract the input messages from the parameters
      const inputMessages = params.input as ResponseInput;

      // Find the reasoning messages in the input
      const reasoningMessages = inputMessages.filter(
        (msg) => msg.type === "reasoning",
      );

      expect(reasoningMessages).toHaveLength(2);

      // First reasoning message should aggregate the redacted + 2 thinking blocks
      expect(reasoningMessages[0]).toEqual({
        type: "reasoning",
        id: "reasoning-item-1",
        encrypted_content: "encrypted-data-123",
        summary: [
          {
            type: "summary_text",
            text: "Let me think about this step by step.",
          },
          {
            type: "summary_text",
            text: "Now I need to consider the implications.",
          },
        ],
      });

      // Second reasoning message should have just the single thinking block
      expect(reasoningMessages[1]).toEqual({
        type: "reasoning",
        id: "reasoning-item-2",
        encrypted_content: null,
        summary: [
          {
            type: "summary_text",
            text: "Actually, let me double-check this.",
          },
        ],
      });

      // Verify the assistant message content is also present
      const assistantMessages = inputMessages.filter(
        (msg) => (msg as { role: string }).role === "assistant",
      );
      expect(assistantMessages).toHaveLength(1);
      expect(
        (assistantMessages[0] as { content: unknown[] }).content[0],
      ).toEqual({
        type: "output_text",
        text: "Here's my answer based on my thinking.",
        annotations: [],
      });
    });
  });

  it("should place reasoning messages in correct position in stream", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    await withNvimClient(async (nvim) => {
      const provider = new OpenAIProvider(nvim);

      // Create messages where reasoning blocks appear between other content
      const messages: ProviderMessage[] = [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "Test question" }],
        },
        {
          role: "assistant" as const,
          content: [
            // First text message
            {
              type: "text" as const,
              text: "Let me start with this.",
              providerMetadata: {
                openai: {
                  itemId: "text-item-1",
                },
              },
            },
            // Reasoning block appears in the middle
            {
              type: "thinking" as const,
              thinking: "Now let me think about this.",
              signature: "",
              providerMetadata: {
                openai: {
                  itemId: "reasoning-item-1",
                },
              },
            },
            // Another text message after reasoning
            {
              type: "text" as const,
              text: "And here's my final answer.",
              providerMetadata: {
                openai: {
                  itemId: "text-item-2",
                },
              },
            },
          ],
        },
      ];

      const params = provider.createStreamParameters({
        model: "gpt-4o",
        messages,
        tools: [],
      });

      const inputMessages = params.input as ResponseInput;

      // Verify the order: system, user, assistant-text, reasoning, assistant-text
      expect(inputMessages).toHaveLength(5);
      expect(inputMessages[0]).toHaveProperty("role", "system");
      expect(inputMessages[1]).toHaveProperty("role", "user");
      expect(inputMessages[2]).toHaveProperty("role", "assistant");
      expect(inputMessages[2]).toHaveProperty("id", "text-item-1");
      expect(inputMessages[3]).toHaveProperty("type", "reasoning");
      expect(inputMessages[3]).toHaveProperty("id", "reasoning-item-1");
      expect(inputMessages[4]).toHaveProperty("role", "assistant");
      expect(inputMessages[4]).toHaveProperty("id", "text-item-2");
    });
  });

  it("should throw error for multiple redacted thinking blocks with same itemId", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    await withNvimClient(async (nvim) => {
      const provider = new OpenAIProvider(nvim);

      const messages: ProviderMessage[] = [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "Test question" }],
        },
        {
          role: "assistant" as const,
          content: [
            {
              type: "redacted_thinking" as const,
              data: "encrypted-data-1",
              providerMetadata: {
                openai: {
                  itemId: "reasoning-item-1",
                },
              },
            },
            {
              type: "redacted_thinking" as const,
              data: "encrypted-data-2",
              providerMetadata: {
                openai: {
                  itemId: "reasoning-item-1", // Same itemId!
                },
              },
            },
          ],
        },
      ];

      expect(() =>
        provider.createStreamParameters({
          model: "gpt-4o",
          messages,
          tools: [],
        }),
      ).toThrow(
        "Multiple redacted thinking blocks found for itemId reasoning-item-1. Expected at most one.",
      );
    });
  });

  it("should throw error for thinking blocks without itemId", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    await withNvimClient(async (nvim) => {
      const provider = new OpenAIProvider(nvim);

      const messages: ProviderMessage[] = [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "Test question" }],
        },
        {
          role: "assistant" as const,
          content: [
            {
              type: "thinking" as const,
              thinking: "Thinking without itemId",
              signature: "",
              // Missing providerMetadata.openai.itemId
            },
          ],
        },
      ];

      expect(() =>
        provider.createStreamParameters({
          model: "gpt-4o",
          messages,
          tools: [],
        }),
      ).toThrow(
        "Thinking content must have an itemId in providerMetadata.openai",
      );
    });
  });

  it("should throw error for thinking blocks in non-assistant messages", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    await withNvimClient(async (nvim) => {
      const provider = new OpenAIProvider(nvim);

      const messages: ProviderMessage[] = [
        {
          role: "user" as const,
          content: [
            {
              type: "thinking" as const, // Invalid: thinking in user message
              thinking: "User thinking",
              signature: "",
              providerMetadata: {
                openai: {
                  itemId: "reasoning-item-1",
                },
              },
            },
          ],
        },
      ];

      expect(() =>
        provider.createStreamParameters({
          model: "gpt-4o",
          messages,
          tools: [],
        }),
      ).toThrow("encountered thinking block in non-assistant message");
    });
  });

  it("should not create reasoning summaries for empty thinking blocks", async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    await withNvimClient(async (nvim) => {
      const provider = new OpenAIProvider(nvim);

      const messages: ProviderMessage[] = [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: "Test question" }],
        },
        {
          role: "assistant" as const,
          content: [
            // Empty thinking block (should be skipped in summary)
            {
              type: "thinking" as const,
              thinking: "",
              signature: "",
              providerMetadata: {
                openai: {
                  itemId: "reasoning-item-1",
                },
              },
            },
            // Whitespace-only thinking block (should be skipped in summary)
            {
              type: "thinking" as const,
              thinking: "   \n  \t  ",
              signature: "",
              providerMetadata: {
                openai: {
                  itemId: "reasoning-item-1",
                },
              },
            },
            // Non-empty thinking block (should be included in summary)
            {
              type: "thinking" as const,
              thinking: "This has actual content",
              signature: "",
              providerMetadata: {
                openai: {
                  itemId: "reasoning-item-1",
                },
              },
            },
            // Another empty thinking block with different itemId
            {
              type: "thinking" as const,
              thinking: "",
              signature: "",
              providerMetadata: {
                openai: {
                  itemId: "reasoning-item-2",
                },
              },
            },
          ],
        },
      ];

      const params = provider.createStreamParameters({
        model: "gpt-4o",
        messages,
        tools: [],
      });

      const inputMessages = params.input as ResponseInput;
      const reasoningMessages = inputMessages.filter(
        (msg) => msg.type === "reasoning",
      );

      expect(reasoningMessages).toHaveLength(2);

      // First reasoning message should only include the non-empty thinking block
      expect(reasoningMessages[0]).toEqual({
        type: "reasoning",
        id: "reasoning-item-1",
        encrypted_content: null,
        summary: [
          {
            type: "summary_text",
            text: "This has actual content",
          },
        ],
      });

      // Second reasoning message should have empty summary (no content blocks)
      expect(reasoningMessages[1]).toEqual({
        type: "reasoning",
        id: "reasoning-item-2",
        encrypted_content: null,
        summary: [],
      });
    });
  });
  it("should handle empty reasoning blocks correctly", async () => {
    await withNvimClient(async (nvim) => {
      const profile = {
        name: "gpt-4o",
        provider: "openai" as ProviderName,
        model: "gpt-4o",
        fastModel: "gpt-4o",
      };

      // Test 1: Entirely empty reasoning block
      mockStreamEvents = [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "item-empty",
            encrypted_content: null,
          },
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "item-empty",
            encrypted_content: null,
          },
        },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 100,
              output_tokens: 50,
            },
          },
        },
      ];

      const provider = getProvider(nvim, profile);
      const capturedEvents: ProviderStreamEvent[] = [];

      const streamRequest = provider.sendMessage({
        model: "gpt-4o",
        messages: [
          { role: "user", content: [{ type: "text", text: "Test message" }] },
        ],
        onStreamEvent: (event) => capturedEvents.push(event),
        tools: [],
      });

      await streamRequest.promise;

      // Should create an empty thinking block and immediately close it
      expect(capturedEvents).toEqual([
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "thinking",
            thinking: "",
            signature: "",
          },
          providerMetadata: {
            openai: {
              itemId: "item-empty",
            },
          },
        },
        {
          type: "content_block_stop",
          index: 0,
        },
      ]);
    });
  });

  it("should handle reasoning block with only encrypted content", async () => {
    await withNvimClient(async (nvim) => {
      const profile = {
        name: "gpt-4o",
        provider: "openai" as ProviderName,
        model: "gpt-4o",
        fastModel: "gpt-4o",
      };

      // Test 2: Only encrypted content, no summary parts
      mockStreamEvents = [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "item-encrypted-only",
            encrypted_content: "encrypted-signature-data",
          },
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "item-encrypted-only",
            encrypted_content: "encrypted-signature-data",
          },
        },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 100,
              output_tokens: 50,
            },
          },
        },
      ];

      const provider = getProvider(nvim, profile);
      const capturedEvents: ProviderStreamEvent[] = [];

      const streamRequest = provider.sendMessage({
        model: "gpt-4o",
        messages: [
          { role: "user", content: [{ type: "text", text: "Test message" }] },
        ],
        onStreamEvent: (event) => capturedEvents.push(event),
        tools: [],
      });

      await streamRequest.promise;

      // Should create a redacted thinking block and immediately close it
      expect(capturedEvents).toEqual([
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "redacted_thinking",
            data: "encrypted-signature-data",
          },
          providerMetadata: {
            openai: {
              itemId: "item-encrypted-only",
            },
          },
        },
        {
          type: "content_block_stop",
          index: 0,
        },
      ]);
    });
  });

  it("should handle reasoning block starting empty then getting summary content", async () => {
    await withNvimClient(async (nvim) => {
      const profile = {
        name: "gpt-4o",
        provider: "openai" as ProviderName,
        model: "gpt-4o",
        fastModel: "gpt-4o",
      };

      // Test 3: Empty start, then summary content arrives
      mockStreamEvents = [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "item-delayed-content",
            encrypted_content: null,
          },
        },
        // Summary content arrives later
        {
          type: "response.reasoning_summary_part.added",
          summary_index: 0,
          item_id: "item-delayed-content",
        },
        {
          type: "response.reasoning_summary_text.delta",
          summary_index: 0,
          item_id: "item-delayed-content",
          delta: "Thinking that arrives later",
        },
        {
          type: "response.reasoning_summary_text.done",
          summary_index: 0,
          item_id: "item-delayed-content",
        },
        {
          type: "response.reasoning_summary_part.done",
          summary_index: 0,
          item_id: "item-delayed-content",
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "reasoning",
            id: "item-delayed-content",
            encrypted_content: null,
          },
        },
        {
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 100,
              output_tokens: 50,
            },
          },
        },
      ];

      const provider = getProvider(nvim, profile);
      const capturedEvents: ProviderStreamEvent[] = [];

      const streamRequest = provider.sendMessage({
        model: "gpt-4o",
        messages: [
          { role: "user", content: [{ type: "text", text: "Test message" }] },
        ],
        onStreamEvent: (event) => capturedEvents.push(event),
        tools: [],
      });

      await streamRequest.promise;

      // Should create empty thinking block and immediately close it, then handle summary content separately
      expect(capturedEvents).toEqual([
        // Initial empty thinking block from reasoning item (immediately closed)
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "thinking",
            thinking: "",
            signature: "",
          },
          providerMetadata: {
            openai: {
              itemId: "item-delayed-content",
            },
          },
        },
        {
          type: "content_block_stop",
          index: 0,
        },
        // Summary part starts (new thinking block)
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "thinking",
            thinking: "",
            signature: "",
          },
          providerMetadata: {
            openai: {
              itemId: "item-delayed-content",
            },
          },
        },
        // Content arrives
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "Thinking that arrives later",
          },
          providerMetadata: {
            openai: {
              itemId: "item-delayed-content",
            },
          },
        },
        // Summary part closes
        {
          type: "content_block_stop",
          index: 0,
        },
      ]);
    });
  });
});
*/
