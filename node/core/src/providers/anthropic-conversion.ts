import type Anthropic from "@anthropic-ai/sdk";
import type { ToolName, ToolRequestId, ValidateInput } from "../tool-types.ts";
import type {
  NativeMessageIdx,
  ProviderMessage,
  ProviderToolResult,
  StreamStopReason,
  Usage,
} from "./provider-types.ts";
import { classifyTextContent } from "./tagged-content.ts";

/** What the provider reported for one assistant message, kept out-of-band
 * because the native message array has no field for it. */
export type MessageStopInfo = {
  stopReason: StreamStopReason;
  usage: Usage;
};

/** Convert Anthropic messages to ProviderMessages. Exported for use in tests. */
export function convertAnthropicMessagesToProvider(
  validateInput: ValidateInput,
  messages: Anthropic.MessageParam[],
  messageStopInfo?: Map<number, MessageStopInfo>,
): ProviderMessage[] {
  return messages.map((msg, msgIndex): ProviderMessage => {
    const stopInfo = messageStopInfo?.get(msgIndex);
    const nativeMessageIdx = msgIndex as NativeMessageIdx;
    const content =
      typeof msg.content === "string"
        ? [
            {
              type: "text" as const,
              text: msg.content,
              nativeMessageIdx,
            },
          ]
        : msg.content.map((block) =>
            convertBlockToProvider(validateInput, block, nativeMessageIdx),
          );

    const result: ProviderMessage = {
      role: msg.role === "system" ? "user" : msg.role,
      content,
    };

    // Attach stop info to assistant messages
    if (stopInfo && msg.role === "assistant") {
      result.stopReason = stopInfo.stopReason;
      result.usage = stopInfo.usage;
    }

    return result;
  });
}

function convertBlockToProvider(
  validateInput: ValidateInput,
  block: Anthropic.Messages.ContentBlockParam,
  nativeMessageIdx: NativeMessageIdx,
): ProviderMessage["content"][number] {
  switch (block.type) {
    case "text": {
      const tagged = classifyTextContent(block.text, nativeMessageIdx);
      if (tagged) return tagged;
      return {
        type: "text",
        text: block.text,
        nativeMessageIdx,
        citations: block.citations
          ? block.citations
              .filter(
                (
                  c,
                ): c is Extract<
                  (typeof block.citations)[number],
                  { url: string }
                > => "url" in c,
              )
              .map((c) => ({
                type: "web_search_citation" as const,
                cited_text: c.cited_text,
                encrypted_index: c.encrypted_index,
                title: c.title || "",
                url: c.url,
              }))
          : undefined,
      };
    }

    case "image":
      return {
        type: "image",
        source: block.source as {
          type: "base64";
          media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
          data: string;
        },
        nativeMessageIdx,
      };

    case "document":
      return {
        type: "document",
        source: block.source as {
          type: "base64";
          media_type: "application/pdf";
          data: string;
        },
        title: block.title ?? undefined,
        nativeMessageIdx,
      };

    case "tool_use": {
      const inputResult = validateInput(
        block.name as ToolName,
        block.input as Record<string, unknown>,
      );
      return {
        type: "tool_use",
        id: block.id as ToolRequestId,
        name: block.name as ToolName,
        request:
          inputResult.status === "ok"
            ? {
                status: "ok" as const,
                value: {
                  id: block.id as ToolRequestId,
                  toolName: block.name as ToolName,
                  input: inputResult.value,
                },
              }
            : { ...inputResult, rawRequest: block.input },
        nativeMessageIdx,
      };
    }

    case "tool_result": {
      let contents: ProviderToolResult["result"];

      if (typeof block.content === "string") {
        contents = block.is_error
          ? { status: "error", error: block.content }
          : {
              status: "ok",
              value: [
                {
                  type: "text",
                  text: block.content,
                  nativeMessageIdx,
                },
              ],
              structuredResult: {
                toolName: "unknown" as ToolName,
              },
            };
      } else if (block.is_error) {
        const textBlock = block.content?.find((c) => c.type === "text") as
          | { type: "text"; text: string }
          | undefined;
        contents = {
          status: "error",
          error: textBlock?.text || "Unknown error",
        };
      } else {
        const blockContent = block.content || [];
        contents = {
          status: "ok",
          value: blockContent
            .filter(
              (
                c,
              ): c is
                | Anthropic.Messages.TextBlockParam
                | Anthropic.Messages.ImageBlockParam =>
                c.type === "text" || c.type === "image",
            )
            .map((c) => {
              if (c.type === "text") {
                return {
                  type: "text" as const,
                  text: c.text,
                  nativeMessageIdx,
                };
              } else {
                return {
                  type: "image" as const,
                  source: c.source as {
                    type: "base64";
                    media_type:
                      | "image/jpeg"
                      | "image/png"
                      | "image/gif"
                      | "image/webp";
                    data: string;
                  },
                  nativeMessageIdx,
                };
              }
            }),
          structuredResult: {
            toolName: "unknown" as ToolName,
          },
        };
      }

      return {
        type: "tool_result",
        id: block.tool_use_id as ToolRequestId,
        result: contents,
        nativeMessageIdx,
      };
    }

    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        nativeMessageIdx,
      };

    case "redacted_thinking":
      return {
        type: "redacted_thinking",
        data: block.data,
        nativeMessageIdx,
      };

    default:
      // Handle server_tool_use, web_search_tool_result etc.
      if ((block as { type: string }).type === "server_tool_use") {
        const serverBlock = block as {
          type: "server_tool_use";
          id: string;
          name: string;
          input: { query: string };
        };
        return {
          type: "server_tool_use",
          id: serverBlock.id,
          name: "web_search",
          input: serverBlock.input,
          nativeMessageIdx,
        };
      }
      if ((block as { type: string }).type === "web_search_tool_result") {
        const resultBlock = block as {
          type: "web_search_tool_result";
          tool_use_id: string;
          content: Anthropic.WebSearchToolResultBlockContent;
        };
        return {
          type: "web_search_tool_result",
          tool_use_id: resultBlock.tool_use_id,
          content: resultBlock.content,
          nativeMessageIdx,
        };
      }
      // Fallback for unknown types
      return {
        type: "text",
        text: `[Unknown block type: ${(block as { type: string }).type}]`,
        nativeMessageIdx,
      };
  }
}
