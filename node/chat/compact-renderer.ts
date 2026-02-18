import type {
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolResult,
  ProviderToolUseContent,
} from "../providers/provider-types.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import type { ToolName } from "../tools/types.ts";
type ToolInfoMap = Map<ToolRequestId, ToolName>;

/** Render a thread's messages to a markdown string suitable for compaction.
 *
 * Filters out thinking blocks, system reminders, and file contents from get_file
 * results. Summarizes binary content. Preserves tool use details and text output.
 */
export function renderThreadToMarkdown(
  messages: ReadonlyArray<ProviderMessage>,
): string {
  const toolInfoMap: ToolInfoMap = new Map();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_use" && block.request.status === "ok") {
        toolInfoMap.set(block.request.value.id, block.request.value.toolName);
      }
    }
  }

  const parts: string[] = [];

  for (const message of messages) {
    parts.push(`# ${message.role}:\n`);
    for (const block of message.content) {
      parts.push(renderContentBlock(block, toolInfoMap));
    }
    parts.push("");
  }

  return parts.join("\n");
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
/** Extract file paths from context_update text.
 * Matches patterns like `File \`path\`` and `- \`path\`` */
function extractFilePathsFromContextUpdate(text: string): string[] {
  const paths: string[] = [];
  // Match "File `path`" (whole file) and "- `path`" (diff/deleted/error)
  const regex = /(?:^File |^- )`([^`]+)`/gm;
  let match;
  while ((match = regex.exec(text)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}
