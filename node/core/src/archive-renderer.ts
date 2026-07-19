import type {
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolResult,
  ProviderToolUseContent,
} from "./providers/provider-types.ts";
import type { ThreadLogEntry } from "./thread-logger.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";

type ToolInfoMap = Map<ToolRequestId, ToolName>;

/**
 * Render a thread's full log stream to markdown for a human browsing the
 * archive. Unlike `renderThreadToMarkdown` (compaction), this renders
 * liberally: thinking blocks, system reminders/info, context updates, and full
 * tool results (including `get_files` contents) are kept. Non-message log
 * entries (compaction/title/fork/thread_start/restart) are emitted inline so
 * the transcript reflects the actual sequence of events.
 */
export function renderThreadLogToMarkdown(
  entries: ReadonlyArray<ThreadLogEntry>,
): string {
  const toolInfoMap: ToolInfoMap = new Map();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    for (const block of entry.message.content) {
      if (block.type === "tool_use" && block.request.status === "ok") {
        toolInfoMap.set(block.request.value.id, block.request.value.toolName);
      }
    }
  }

  const parts: string[] = [];
  for (const entry of entries) {
    parts.push(renderEntry(entry, toolInfoMap));
  }
  return parts.join("\n");
}

function renderEntry(entry: ThreadLogEntry, toolInfoMap: ToolInfoMap): string {
  switch (entry.type) {
    case "message":
      return renderMessage(entry.message, toolInfoMap);
    case "thread_start":
      return `--- thread start (${entry.threadType}) ---\n`;
    case "restart":
      return `--- restart ---\n`;
    case "fork":
      return `--- fork from ${entry.fromThreadId} @ message ${entry.nativeMessageIdx} ---\n`;
    case "title":
      return `# title: "${entry.title}"\n`;
    case "compaction": {
      const header = `--- compaction (${entry.chunkCount} chunks) ---`;
      if (entry.summary) {
        return `${header}\n${entry.summary}\n`;
      }
      return `${header}\n`;
    }
  }
}

function renderMessage(
  message: ProviderMessage,
  toolInfoMap: ToolInfoMap,
): string {
  const parts: string[] = [`# ${message.role}:\n`];
  for (const block of message.content) {
    parts.push(renderContentBlock(block, toolInfoMap));
  }
  return parts.join("\n");
}

function renderContentBlock(
  block: ProviderMessageContent,
  toolInfoMap: ToolInfoMap,
): string {
  switch (block.type) {
    case "text":
      return `${block.text}\n`;

    case "thinking":
      return `## thinking\n${block.thinking}\n`;

    case "redacted_thinking":
      return `## redacted thinking\n[redacted]\n`;

    case "system_reminder":
      return `## system reminder\n${block.text}\n`;

    case "system_info":
      return `## system info\n${block.text}\n`;

    case "fork_notification":
      return `## fork notification\n${block.text}\n`;

    case "context_update":
      return `## context update\n${block.text}\n`;

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
  const label = toolName ? `## tool_result: ${toolName}` : `## tool_result`;

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
    return `${label}\n${contentParts.join("\n")}\n`;
  }
  return `${label} (error)\n${block.result.error}\n`;
}
