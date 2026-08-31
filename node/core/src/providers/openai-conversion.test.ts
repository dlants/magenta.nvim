import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { validateInput } from "../tools/helpers.ts";
import { convertOpenAIItemsToProvider } from "./openai-conversion.ts";

type Item = OpenAI.Responses.ResponseInputItem;

const convert = (items: Item[]) =>
  convertOpenAIItemsToProvider(validateInput, items);

describe("convertOpenAIItemsToProvider", () => {
  it("groups consecutive items by role and stamps nativeMessageIdx", () => {
    const items: Item[] = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "pondering" }],
      },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "on it", annotations: [] }],
      } as OpenAI.Responses.ResponseOutputMessage,
      {
        type: "function_call",
        call_id: "call_1",
        name: "bash_command",
        arguments: '{"command":"ls"}',
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "bash_command",
        arguments: '{"command":"pwd"}',
      },
      { type: "function_call_output", call_id: "call_1", output: "a\nb" },
      { type: "function_call_output", call_id: "call_2", output: "/tmp" },
    ];

    const messages = convert(items);
    expect(messages).toHaveLength(3);

    expect(messages[0].role).toBe("user");
    expect(messages[0].content.map((c) => c.type)).toEqual(["text"]);

    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content.map((c) => c.type)).toEqual([
      "thinking",
      "text",
      "tool_use",
      "tool_use",
    ]);

    expect(messages[2].role).toBe("user");
    expect(messages[2].content.map((c) => c.type)).toEqual([
      "tool_result",
      "tool_result",
    ]);

    // Every block carries the index of the item it came from, not the message.
    expect(
      messages.flatMap((m) => m.content.map((c) => c.nativeMessageIdx)),
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("attaches stop info to the message owning the item it is keyed by", () => {
    const items: Item[] = [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
      { role: "assistant", content: "done" },
    ];
    const stopInfo = new Map([
      [
        1,
        {
          stopReason: "end_turn" as const,
          usage: { inputTokens: 3, outputTokens: 4 },
        },
      ],
    ]);
    const messages = convertOpenAIItemsToProvider(
      validateInput,
      items,
      stopInfo,
    );
    expect(messages[0].stopReason).toBeUndefined();
    expect(messages[1].stopReason).toBe("end_turn");
    expect(messages[1].usage).toEqual({ inputTokens: 3, outputTokens: 4 });
  });

  it("joins multi-part reasoning summaries for display, leaving the item untouched", () => {
    const item: Item = {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "enc",
      summary: [
        { type: "summary_text", text: "first" },
        { type: "summary_text", text: "second" },
      ],
    };
    const messages = convert([item]);
    const block = messages[0].content[0];
    expect(block).toMatchObject({
      type: "thinking",
      thinking: "first\n\nsecond",
      signature: "enc",
    });
    expect(
      (item as OpenAI.Responses.ResponseReasoningItem).summary,
    ).toHaveLength(2);
  });

  it("re-tags tagged user text rather than rendering it raw", () => {
    const messages = convert([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<context_update>\nfoo\n</context_update>",
          },
          {
            type: "input_text",
            text: "<comment_update>\nbar\n</comment_update>",
          },
          {
            type: "input_text",
            text: "<system-reminder>baz</system-reminder>",
          },
          { type: "input_text", text: "plain" },
        ],
      },
    ]);
    expect(messages[0].content.map((c) => c.type)).toEqual([
      "context_update",
      "comment_update",
      "system_reminder",
      "text",
    ]);
  });

  it("converts a web_search_call and its annotated message", () => {
    const messages = convert([
      {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: { type: "search", query: "magenta.nvim" },
      } as Item,
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: "found it",
            annotations: [
              {
                type: "url_citation",
                start_index: 0,
                end_index: 8,
                title: "Magenta",
                url: "https://example.com",
              },
            ],
          },
        ],
      } as OpenAI.Responses.ResponseOutputMessage,
    ]);

    expect(messages).toHaveLength(1);
    expect(messages[0].content[0]).toMatchObject({
      type: "server_tool_use",
      id: "ws_1",
      name: "web_search",
      input: { query: "magenta.nvim" },
    });
    expect(messages[0].content[1]).toMatchObject({
      type: "text",
      text: "found it",
      citations: [
        {
          type: "web_search_citation",
          title: "Magenta",
          url: "https://example.com",
        },
      ],
    });
  });

  it("drops item kinds with no display representation without breaking grouping", () => {
    const messages = convert([
      { role: "assistant", content: "a" },
      { type: "item_reference", id: "itm_1" } as Item,
      { role: "assistant", content: "b" },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0].content.map((c) => c.nativeMessageIdx)).toEqual([0, 2]);
  });
});
