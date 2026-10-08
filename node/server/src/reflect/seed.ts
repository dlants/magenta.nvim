import {
  isSelectionAnchor,
  type ReflectionOriginAnchor,
} from "../chat-types.ts";
import {
  buildToolInfoMap,
  renderContentBlock,
  type ToolInfoMap,
} from "../compact-renderer.ts";
import type {
  AgentInput,
  ProviderMessage,
  ProviderMessageContent,
  ProviderToolResult,
  ProviderToolUseContent,
} from "../providers/provider-types.ts";

export const REFLECT_SEED_MAX_CHARS = 200_000;
const TOOL_INPUT_MAX_CHARS = 200;
const TOOL_RESULT_MAX_CHARS = 1000;

/** Two inputs: the tagged transcript, then the user's selection as plain
 * text. The selection is display buffer text; this is the one place it
 * becomes message text. */
export function buildReflectSeed(args: {
  history: ReadonlyArray<ProviderMessage>;
  anchor: ReflectionOriginAnchor;
}): AgentInput[] {
  const { history, anchor } = args;
  const rendered = renderReflectHistory(
    history.slice(0, anchor.messageIdx + 1),
  );
  const context: AgentInput = {
    type: "text",
    text: `<thread-context>\n${rendered}\n</thread-context>`,
  };
  if (!isSelectionAnchor(anchor)) return [context];
  const quoted = anchor.reflectionText
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return [context, { type: "text", text: `The user selected:\n${quoted}` }];
}

type Detail = "full" | "no-tool-results";

/** Abridged, deterministic transcript for a reflect seed. The last message
 * (the one containing the selection) is always kept in full. */
export function renderReflectHistory(
  messages: ReadonlyArray<ProviderMessage>,
  maxChars: number = REFLECT_SEED_MAX_CHARS,
): string {
  const toolInfoMap = buildToolInfoMap(messages);
  const details: Detail[] = messages.map(() => "full");
  const rendered = messages.map((m) => renderMessage(m, "full", toolInfoMap));
  const total = () => rendered.reduce((n, s) => n + s.length, 0);

  const last = messages.length - 1;
  for (let i = 0; i < last && total() > maxChars; i++) {
    details[i] = "no-tool-results";
    rendered[i] = renderMessage(messages[i], details[i], toolInfoMap);
  }

  let omitted = 0;
  while (omitted < last && total() > maxChars) {
    rendered[omitted] = "";
    omitted++;
  }

  const parts = rendered.slice(omitted);
  if (omitted > 0) parts.unshift(`[${omitted} earlier messages omitted]\n`);
  return parts.join("\n");
}

function renderMessage(
  message: ProviderMessage,
  detail: Detail,
  toolInfoMap: ToolInfoMap,
): string {
  const blocks = message.content
    .map((block) => renderBlock(block, detail, toolInfoMap))
    .filter((s) => s.length > 0);
  return [`# ${message.role}:`, ...blocks].join("\n");
}

function renderBlock(
  block: ProviderMessageContent,
  detail: Detail,
  toolInfoMap: ToolInfoMap,
): string {
  switch (block.type) {
    case "tool_use":
      return renderToolUse(block);
    case "tool_result":
      if (detail === "no-tool-results") return "";
      return renderToolResult(block, toolInfoMap);
    default:
      return renderContentBlock(block, toolInfoMap);
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}[… ${text.length - max} chars omitted]`;
}

function renderToolUse(block: ProviderToolUseContent): string {
  if (block.request.status !== "ok") return "[tool_use: (parse error)]\n";
  const { toolName, input } = block.request.value;
  return `[tool_use: ${toolName} ${truncate(JSON.stringify(input), TOOL_INPUT_MAX_CHARS)}]\n`;
}

function renderToolResult(
  block: ProviderToolResult,
  toolInfoMap: ToolInfoMap,
): string {
  if (toolInfoMap.get(block.id) === "get_files") {
    // renderContentBlock omits get_files contents already.
    return renderContentBlock(block, toolInfoMap);
  }
  if (block.result.status !== "ok") {
    return `[tool_result (error)]\n${truncate(block.result.error, TOOL_RESULT_MAX_CHARS)}\n`;
  }
  const text = block.result.value
    .map((item) =>
      item.type === "text"
        ? item.text
        : item.type === "image"
          ? "[Image]"
          : `[Document${item.title ? `: ${item.title}` : ""}]`,
    )
    .join("\n");
  return `[tool_result]\n${truncate(text, TOOL_RESULT_MAX_CHARS)}\n`;
}
