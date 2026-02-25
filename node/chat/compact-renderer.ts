import type {
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolResult,
  ProviderToolUseContent,
} from "../providers/provider-types.ts";
import type { ToolRequestId, ToolName } from "@magenta/core";
type ToolInfoMap = Map<ToolRequestId, ToolName>;

export type RenderResult = {
  markdown: string;
  /** Character offset in `markdown` where each message starts */
  messageBoundaries: number[];
};

/** Render a thread's messages to a markdown string suitable for compaction.
 *
 * Filters out thinking blocks, system reminders, and file contents from get_file
 * results. Summarizes binary content. Preserves tool use details and text output.
 */
export function renderThreadToMarkdown(
  messages: ReadonlyArray<ProviderMessage>,
): RenderResult {
  const toolInfoMap: ToolInfoMap = new Map();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_use" && block.request.status === "ok") {
        toolInfoMap.set(block.request.value.id, block.request.value.toolName);
      }
    }
  }

  const parts: string[] = [];
  const messageBoundaries: number[] = [];
  let currentLength = 0;

  for (const message of messages) {
    messageBoundaries.push(currentLength);
    const header = `# ${message.role}:\n`;
    parts.push(header);
    currentLength += header.length + 1; // +1 for join separator
    for (const block of message.content) {
      const rendered = renderContentBlock(block, toolInfoMap);
      parts.push(rendered);
      currentLength += rendered.length + 1;
    }
    parts.push("");
    currentLength += 1; // empty string + join separator
  }

  return { markdown: parts.join("\n"), messageBoundaries };
}

export const CHARS_PER_TOKEN = 4;
export const TARGET_CHUNK_TOKENS = 25_000;
export const TOLERANCE_TOKENS = 5_000;

/** Split rendered markdown into chunks at message boundaries, respecting a token budget.
 *
 * Greedily adds messages until the chunk exceeds targetChunkChars. If a single
 * message exceeds targetChunkChars + toleranceChars, it is split at a character boundary.
 */
export function chunkMessages(
  markdown: string,
  messageBoundaries: number[],
  targetChunkChars: number,
  toleranceChars: number,
): string[] {
  if (messageBoundaries.length === 0) return [];

  // Extract individual message strings
  const messageTexts: string[] = [];
  for (let i = 0; i < messageBoundaries.length; i++) {
    const start = messageBoundaries[i];
    const end =
      i + 1 < messageBoundaries.length
        ? messageBoundaries[i + 1]
        : markdown.length;
    messageTexts.push(markdown.slice(start, end));
  }

  const maxChunkChars = targetChunkChars + toleranceChars;
  const chunks: string[] = [];
  let currentChunk = "";

  for (const msgText of messageTexts) {
    if (currentChunk.length === 0 && msgText.length <= maxChunkChars) {
      // Start a new chunk with this message
      currentChunk = msgText;
    } else if (currentChunk.length + msgText.length <= maxChunkChars) {
      // Fits in the current chunk
      currentChunk += msgText;
    } else if (currentChunk.length >= targetChunkChars) {
      // Current chunk already at target, flush it and start new with this message
      chunks.push(currentChunk);
      if (msgText.length <= maxChunkChars) {
        currentChunk = msgText;
      } else {
        // This single message is oversized, split it
        currentChunk = "";
        splitOversizedText(msgText, targetChunkChars, chunks);
      }
    } else {
      // Current chunk is under target; add what fits, then split remainder
      const combined = currentChunk + msgText;
      if (combined.length <= maxChunkChars) {
        currentChunk = combined;
      } else {
        // Split: fill current chunk to target, then split the rest
        splitOversizedText(combined, targetChunkChars, chunks);
        currentChunk = "";
      }
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function splitOversizedText(
  text: string,
  chunkSize: number,
  chunks: string[],
): void {
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
}

function renderContentBlock(
  block: ProviderMessageContent,
  toolInfoMap: ToolInfoMap,
): string {
  switch (block.type) {
    case "text":
      return block.text + "\n";

    case "thinking":
    case "redacted_thinking":
    case "system_reminder":
      return "";

    case "context_update": {
      const files = extractFilePathsFromContextUpdate(block.text);
      if (files.length > 0) {
        return `[context update: ${files.map((f) => "`" + f + "`").join(", ")}]\n`;
      }
      return `[context update]\n`;
    }

    case "tool_use":
      return renderToolUse(block);

    case "tool_result":
      return renderToolResult(block, toolInfoMap);

    case "image":
      return `[Image]\n`;

    case "document":
      return `[Document${block.title ? `: ${block.title}` : ""}]\n`;

    case "server_tool_use":
      return `[web search: ${block.input.query}]\n`;

    case "web_search_tool_result": {
      if (
        "type" in block.content &&
        block.content.type === "web_search_tool_result_error"
      ) {
        return `[search error: ${block.content.error_code}]\n`;
      }
      if (Array.isArray(block.content)) {
        const results = block.content
          .filter(
            (r): r is Extract<typeof r, { type: "web_search_result" }> =>
              r.type === "web_search_result",
          )
          .map(
            (r) =>
              `  - [${r.title}](${r.url})${r.page_age ? ` (${r.page_age})` : ""}`,
          );
        if (results.length > 0) {
          return `[search results]\n${results.join("\n")}\n`;
        }
      }
      return `[search results]\n`;
    }
  }
}

function renderToolUse(block: ProviderToolUseContent): string {
  if (block.request.status === "ok") {
    const { toolName, input } = block.request.value;
    return `## tool_use: ${toolName}\n\`\`\`json\n${JSON.stringify(input, undefined, 2)}\n\`\`\`\n`;
  }
  return `## tool_use: (parse error)\n`;
}

function renderToolResult(
  block: ProviderToolResult,
  toolInfoMap: ToolInfoMap,
): string {
  const toolName = toolInfoMap.get(block.id);

  // For get_file results, just indicate success/failure without the full content
  if (toolName === "get_file") {
    if (block.result.status === "ok") {
      return `## tool_result\n[file contents omitted]\n`;
    }
    return `## tool_result (error)\n${block.result.error}\n`;
  }

  if (block.result.status === "ok") {
    const contentParts: string[] = [];
    for (const item of block.result.value) {
      switch (item.type) {
        case "text":
          contentParts.push(item.text);
          break;
        case "image":
          contentParts.push("[Image]");
          break;
        case "document":
          contentParts.push(`[Document${item.title ? `: ${item.title}` : ""}]`);
          break;
      }
    }
    return `## tool_result\n${contentParts.join("\n")}\n`;
  }
  return `## tool_result (error)\n${block.result.error}\n`;
}
/** Extract file paths from the <file_paths> section of a context_update.
 * Each line in the section is formatted as "path (metadata)". */
function extractFilePathsFromContextUpdate(text: string): string[] {
  const filePathsMatch = text.match(/<file_paths>([\s\S]*?)<\/file_paths>/);
  if (!filePathsMatch) {
    return [];
  }
  return filePathsMatch[1]
    .split("\n")
    .map((line) => line.replace(/\s+\(.*\)$/, "").trim())
    .filter((line) => line.length > 0);
}
