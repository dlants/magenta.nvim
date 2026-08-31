import type OpenAI from "openai";
import type { ToolName, ToolRequestId, ValidateInput } from "../tool-types.ts";
import { parseToolRequest, webSearchQuery } from "./openai.ts";
import type {
  NativeMessageIdx,
  ProviderImageContent,
  ProviderMessage,
  ProviderMessageContent,
  ProviderWebSearchCitation,
  StreamStopReason,
  Usage,
} from "./provider-types.ts";
import { classifyTextContent } from "./tagged-content.ts";

/** What the provider reported for one assistant turn, keyed by the index of the
 * turn's last item. The native item array has no field for it. */
export type ItemStopInfo = {
  stopReason: StreamStopReason;
  usage: Usage;
};

type Item = OpenAI.Responses.ResponseInputItem;

/** Native items -> display messages. The only direction.
 *
 * The Responses API input is a flat item list, not a message list: reasoning
 * and function_call items have no enclosing message. The grouping into
 * `ProviderMessage`s happens here — consecutive items belonging to the
 * assistant collapse into one assistant message, consecutive user/tool-output
 * items into one user message. Every content block is stamped with the index of
 * the item it came from. */
export function convertOpenAIItemsToProvider(
  validateInput: ValidateInput,
  items: ReadonlyArray<Item>,
  stopInfo?: Map<NativeMessageIdx, ItemStopInfo>,
): ProviderMessage[] {
  const messages: ProviderMessage[] = [];
  const toolNames = toolNamesByCallId(items);

  items.forEach((item, idx) => {
    const nativeMessageIdx = idx as NativeMessageIdx;
    const role = roleOf(item);
    if (!role) return;
    const content = convertItem(
      validateInput,
      item,
      nativeMessageIdx,
      toolNames,
    );

    const last = messages[messages.length - 1];
    // An item that produced no displayable content still owns its stop info, so
    // the group is opened regardless.
    if (last && last.role === role) {
      last.content.push(...content);
    } else {
      messages.push({ role, content });
    }

    const info = stopInfo?.get(nativeMessageIdx);
    if (info && role === "assistant") {
      const target = messages[messages.length - 1];
      target.stopReason = info.stopReason;
      target.usage = info.usage;
    }
  });

  return messages;
}

/** A `function_call_output` carries no tool name on the wire; it is recovered
 * from the `function_call` it answers. */
function toolNamesByCallId(items: ReadonlyArray<Item>): Map<string, ToolName> {
  const names = new Map<string, ToolName>();
  for (const item of items) {
    if (item.type === "function_call") {
      names.set(item.call_id, item.name as ToolName);
    }
  }
  return names;
}

/** Which side of the conversation an item belongs to. `undefined` for item
 * kinds with no display representation at all. */
export function roleOf(item: Item): "user" | "assistant" | undefined {
  if ("role" in item && item.role) {
    return item.role === "assistant" ? "assistant" : "user";
  }
  switch (item.type) {
    case "reasoning":
    case "function_call":
    case "web_search_call":
      return "assistant";
    case "function_call_output":
      return "user";
    default:
      return undefined;
  }
}

function convertItem(
  validateInput: ValidateInput,
  item: Item,
  nativeMessageIdx: NativeMessageIdx,
  toolNames: Map<string, ToolName>,
): ProviderMessageContent[] {
  if ("role" in item && item.role) {
    return convertMessageItem(item, nativeMessageIdx);
  }

  switch (item.type) {
    case "reasoning":
      return [
        {
          type: "thinking",
          // The parts survive verbatim in the native item; the join is a
          // display concern only.
          thinking: item.summary.map((s) => s.text).join("\n\n"),
          ...(item.encrypted_content
            ? { signature: item.encrypted_content }
            : {}),
          nativeMessageIdx,
        },
      ];

    case "function_call":
      return [
        {
          type: "tool_use",
          id: item.call_id as ToolRequestId,
          name: item.name as ToolName,
          request: parseToolRequest(validateInput, item),
          nativeMessageIdx,
        },
      ];

    case "function_call_output":
      return [
        {
          type: "tool_result",
          id: item.call_id as ToolRequestId,
          result: {
            status: "ok",
            value: [
              { type: "text", text: outputText(item.output), nativeMessageIdx },
            ],
            structuredResult: {
              toolName: toolNames.get(item.call_id) ?? ("unknown" as ToolName),
            },
          },
          nativeMessageIdx,
        },
      ];

    case "web_search_call": {
      // Only `search` actions carry a query; `open_page` / `find` have no
      // representation in ProviderServerToolUseContent, so they are dropped.
      const query = webSearchQuery(item);
      if (query === undefined || item.id === undefined) return [];
      return [
        {
          type: "server_tool_use",
          id: item.id,
          name: "web_search",
          input: { query },
          nativeMessageIdx,
        },
      ];
    }

    default:
      return [];
  }
}

/** The SDK types `output` as a string, but the API has begun returning a
 * content-part array for some tools. */
function outputText(
  output: string | ReadonlyArray<{ text?: string | undefined }>,
): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

type MessageItem = Extract<Item, { role: string }>;

function convertMessageItem(
  item: MessageItem,
  nativeMessageIdx: NativeMessageIdx,
): ProviderMessageContent[] {
  const isAssistant = item.role === "assistant";
  const content = item.content;

  if (typeof content === "string") {
    return [textContent(content, nativeMessageIdx, isAssistant, undefined)];
  }

  const out: ProviderMessageContent[] = [];
  for (const part of content) {
    switch (part.type) {
      case "input_text":
        out.push(
          textContent(part.text, nativeMessageIdx, isAssistant, undefined),
        );
        break;

      case "output_text":
        out.push(
          textContent(
            part.text,
            nativeMessageIdx,
            isAssistant,
            citationsOf(part.annotations),
          ),
        );
        break;

      case "input_image": {
        const source = parseImageSource(part.image_url ?? undefined);
        if (source) {
          out.push({ type: "image", source, nativeMessageIdx });
        }
        break;
      }

      case "input_file": {
        const source = parseDataUrl(part.file_data ?? undefined);
        if (source && source.mediaType === "application/pdf") {
          out.push({
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: source.data,
            },
            title: part.filename ?? undefined,
            nativeMessageIdx,
          });
        }
        break;
      }

      default:
        break;
    }
  }
  return out;
}

function textContent(
  text: string,
  nativeMessageIdx: NativeMessageIdx,
  isAssistant: boolean,
  citations: ProviderWebSearchCitation[] | undefined,
): ProviderMessageContent {
  if (!isAssistant) {
    const tagged = classifyTextContent(text, nativeMessageIdx);
    if (tagged) return tagged;
  }
  return {
    type: "text",
    text,
    ...(citations?.length ? { citations } : {}),
    nativeMessageIdx,
  };
}

function citationsOf(
  annotations: ReadonlyArray<{ type: string }> | undefined,
): ProviderWebSearchCitation[] {
  return (annotations ?? [])
    .filter(
      (a): a is OpenAI.Responses.ResponseOutputText.URLCitation =>
        a.type === "url_citation",
    )
    .map((a) => ({
      type: "web_search_citation" as const,
      cited_text: "",
      encrypted_index: "",
      title: a.title,
      url: a.url,
    }));
}

const IMAGE_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

function parseImageSource(
  url: string | undefined,
): ProviderImageContent["source"] | undefined {
  const parsed = parseDataUrl(url);
  if (!parsed) return undefined;
  const mediaType = IMAGE_MEDIA_TYPES.find((t) => t === parsed.mediaType);
  if (!mediaType) return undefined;
  return { type: "base64", media_type: mediaType, data: parsed.data };
}

function parseDataUrl(
  url: string | undefined,
): { mediaType: string; data: string } | undefined {
  if (!url) return undefined;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match) return undefined;
  return { mediaType: match[1], data: match[2] };
}
