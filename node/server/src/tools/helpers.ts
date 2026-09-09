import * as BashCommand from "./bashCommand.ts";
import * as Edl from "./edl.ts";
import * as FindReferences from "./findReferences.ts";
import * as GetFile from "./getFile.ts";
import * as Hover from "./hover.ts";
import * as NvimLua from "./nvimLua.ts";
import * as Reply from "./reply.ts";
import * as RunScript from "./run-script.ts";
import * as SpawnSubagents from "./spawn-subagents.ts";
import * as ThreadTitle from "./thread-title.ts";
import type { StaticToolName } from "./tool-registry.ts";
import * as YieldToParent from "./yield-to-parent.ts";

export function validateInput(
  toolName: unknown,
  input: { [key: string]: unknown },
) {
  const toolNameStr = toolName as string;

  if (toolNameStr.startsWith("mcp_")) {
    return {
      status: "ok" as const,
      value: input,
    };
  }

  switch (toolName as StaticToolName) {
    case "get_files":
      return GetFile.validateInput(input);
    case "hover":
      return Hover.validateInput(input);
    case "find_references":
      return FindReferences.validateInput(input);
    case "bash_command":
      return BashCommand.validateInput(input);
    case "thread_title":
      return ThreadTitle.validateInput(input);
    case "spawn_subagents":
      return SpawnSubagents.validateInput(input);
    case "yield_to_parent":
      return YieldToParent.validateInput(input);
    case "edl":
      return Edl.validateInput(input);
    case "run_script":
      return RunScript.validateInput(input);
    case "nvim_lua":
      return NvimLua.validateInput(input);
    case "reply":
      return Reply.validateInput(input);
    default:
      return {
        status: "error" as const,
        error: `Unexpected toolName: ${toolName as string}`,
      };
  }
}
/** Extract a string value from a partially-streamed JSON object.
 * e.g. given inputJson = `{"script": "file \`foo\`\nselect` and key = "script",
 * returns the unescaped partial string value.
 */
export function extractPartialJsonStringValue(
  inputJson: string,
  key: string,
  fromIndex = 0,
): string | undefined {
  return readStringValue(inputJson, key, fromIndex)?.value;
}

/** One reply as it appears mid-stream: `text` grows as deltas arrive, and is
 * empty until the model starts emitting it. */
export type PartialReply = { commentId: string; text: string };

/** Parse the `reply` tool's input while it is still streaming, so the UI can
 * show a reply landing in its comment as it is written. Assumes the schema
 * order (`commentId` before `text`) that the model emits; a reversed pair is
 * reported with an empty text rather than mis-attributed. */
export function extractPartialReplies(inputJson: string): PartialReply[] {
  const replies: PartialReply[] = [];
  let cursor = 0;
  for (;;) {
    const idField = readStringValue(inputJson, "commentId", cursor);
    if (!idField) break;
    const nextId = readStringValue(inputJson, "commentId", idField.end);
    const textField = readStringValue(inputJson, "text", idField.end);
    const text =
      textField && (!nextId || textField.end <= nextId.end)
        ? textField.value
        : "";
    replies.push({ commentId: idField.value, text });
    cursor = idField.end;
  }
  return replies;
}

function readStringValue(
  inputJson: string,
  key: string,
  fromIndex: number,
): { value: string; end: number } | undefined {
  const keyPattern = `"${key}"`;
  const keyIdx = inputJson.indexOf(keyPattern, fromIndex);
  if (keyIdx === -1) return undefined;

  const afterKey = inputJson.indexOf(":", keyIdx + keyPattern.length);
  if (afterKey === -1) return undefined;

  const openQuote = inputJson.indexOf('"', afterKey + 1);
  if (openQuote === -1) return undefined;

  return decodeJsonString(inputJson, openQuote + 1);
}

/** Decode a JSON string body starting at `start`, tolerating a body that the
 * stream has not finished (or closed) yet. `end` is the index just past the
 * closing quote, or the end of input when it has not arrived. */
function decodeJsonString(
  inputJson: string,
  start: number,
): { value: string; end: number } {
  const encoded = inputJson.slice(start);

  let result = "";
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "\\") {
      i++;
      if (i >= encoded.length) break;
      switch (encoded[i]) {
        case "n":
          result += "\n";
          break;
        case "t":
          result += "\t";
          break;
        case "r":
          result += "\r";
          break;
        case '"':
          result += '"';
          break;
        case "\\":
          result += "\\";
          break;
        case "/":
          result += "/";
          break;
        case "u": {
          const hex = encoded.slice(i + 1, i + 5);
          if (hex.length === 4) {
            result += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          }
          break;
        }
        default:
          result += encoded[i];
      }
    } else if (encoded[i] === '"') {
      return { value: result, end: start + i + 1 };
    } else {
      result += encoded[i];
    }
  }

  return { value: result, end: inputJson.length };
}
