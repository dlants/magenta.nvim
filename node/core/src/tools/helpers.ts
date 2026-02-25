import * as GetFile from "./getFile.ts";
import * as Hover from "./hover.ts";
import * as FindReferences from "./findReferences.ts";
import * as Diagnostics from "./diagnostics.ts";
import * as BashCommand from "./bashCommand.ts";
import * as ThreadTitle from "./thread-title.ts";
import * as SpawnSubagent from "./spawn-subagent.ts";
import * as SpawnForeach from "./spawn-foreach.ts";
import * as WaitForSubagents from "./wait-for-subagents.ts";
import * as YieldToParent from "./yield-to-parent.ts";
import * as Edl from "./edl.ts";
import type { StaticToolName } from "./tool-registry.ts";

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
    case "get_file":
      return GetFile.validateInput(input);
    case "hover":
      return Hover.validateInput(input);
    case "find_references":
      return FindReferences.validateInput(input);
    case "diagnostics":
      return Diagnostics.validateInput();
    case "bash_command":
      return BashCommand.validateInput(input);
    case "thread_title":
      return ThreadTitle.validateInput(input);
    case "spawn_foreach":
      return SpawnForeach.validateInput(input);
    case "spawn_subagent":
      return SpawnSubagent.validateInput(input);
    case "wait_for_subagents":
      return WaitForSubagents.validateInput(input);
    case "yield_to_parent":
      return YieldToParent.validateInput(input);
    case "edl":
      return Edl.validateInput(input);
    default:
      throw new Error(`Unexpected toolName: ${toolName as string}`);
  }
}
/** Extract a string value from a partially-streamed JSON object.
 * e.g. given inputJson = `{"script": "file \`foo\`\nselect` and key = "script",
 * returns the unescaped partial string value.
 */
export function extractPartialJsonStringValue(
  inputJson: string,
  key: string,
): string | undefined {
  const keyPattern = `"${key}"`;
  const keyIdx = inputJson.indexOf(keyPattern);
  if (keyIdx === -1) return undefined;

  const afterKey = inputJson.indexOf(":", keyIdx + keyPattern.length);
  if (afterKey === -1) return undefined;

  const openQuote = inputJson.indexOf('"', afterKey + 1);
  if (openQuote === -1) return undefined;

  const encoded = inputJson.slice(openQuote + 1);

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
      break;
    } else {
      result += encoded[i];
    }
  }

  return result;
}
