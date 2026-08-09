import type Anthropic from "@anthropic-ai/sdk";

/** The Anthropic API rejects assistant messages whose final block is a
 * `thinking` (or `redacted_thinking`) block. This happens when a stream is
 * interrupted (abort/error) after a thinking block but before any text or
 * tool_use block, and the message is later re-sent (e.g. on manual retry).
 * Strip trailing thinking blocks, dropping any assistant message that becomes
 * empty as a result. */
export function stripTrailingThinkingBlocks(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") {
      result.push(message);
      continue;
    }

    let end = message.content.length;
    while (
      end > 0 &&
      (message.content[end - 1].type === "thinking" ||
        message.content[end - 1].type === "redacted_thinking")
    ) {
      end--;
    }

    if (end === message.content.length) {
      result.push(message);
    } else if (end > 0) {
      result.push({ ...message, content: message.content.slice(0, end) });
    }
    // end === 0: assistant message had only thinking blocks; drop it entirely.
  }
  return result;
}

/** We only ever need to place a cache header on the last block, since anthropic now can compute the longest reusable
 * prefix.
 * https://www.anthropic.com/news/token-saving-updates
 */
export function withCacheControl(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  // Find the last eligible block by searching backwards through messages
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const message = messages[messageIndex];
    if (typeof message.content === "string") {
      continue;
    }

    for (
      let blockIndex = message.content.length - 1;
      blockIndex >= 0;
      blockIndex--
    ) {
      const block = message.content[blockIndex];

      // Check if this block is eligible for caching
      if (
        block &&
        typeof block !== "string" &&
        block.type !== "thinking" &&
        block.type !== "redacted_thinking" &&
        !(block.type === "text" && !block.text)
      ) {
        const result = [...messages];
        // Create new array with updated message containing the cache_control block
        const newContent = [...message.content];
        newContent[blockIndex] = {
          ...block,
          cache_control: { type: "ephemeral" },
        };

        result[messageIndex] = {
          ...message,
          content: newContent,
        };
        return result;
      }
    }
  }

  return messages;
}
