import {
  type AgentStreamingBlock,
  assertUnreachable,
  extractPartialJsonStringValue,
  SpawnSubagents,
  type StaticToolName,
  splitScriptByFile,
} from "@magenta/core";
import { d, type VDOMNode, withCode } from "../tea/view.ts";
import { renderSpawnLayout } from "./spawn-subagents.ts";

const PREVIEW_MAX_LINES = 10;
const PREVIEW_MAX_LINE_LENGTH = 80;

function abridgeStreamedText(text: string): string {
  const lines = text.split("\n");
  const preview = lines
    .slice(-PREVIEW_MAX_LINES)
    .map((line) =>
      line.length > PREVIEW_MAX_LINE_LENGTH
        ? `${line.substring(0, PREVIEW_MAX_LINE_LENGTH)}...`
        : line,
    );
  if (lines.length > PREVIEW_MAX_LINES) {
    preview.unshift(`... (${lines.length - PREVIEW_MAX_LINES} more lines)`);
  }
  return preview.join("\n");
}

export function renderStreamdedTool(
  streamingBlock: Extract<AgentStreamingBlock, { type: "tool_use" }>,
): string | VDOMNode {
  if (streamingBlock.name.startsWith("mcp_")) {
    return d`Invoking mcp tool ${streamingBlock.name}`;
  }

  const name = streamingBlock.name as StaticToolName;
  switch (name) {
    case "get_files":
    case "hover":
    case "find_references":
    case "thread_title":
    case "yield_to_parent":
    case "run_script":
    case "nvim_lua":
      break;
    case "scratchpad": {
      const script = extractPartialJsonStringValue(
        streamingBlock.inputJson,
        "script",
      );
      if (script !== undefined) {
        const lines = script.split("\n");
        const tail = lines.slice(-10).join("\n");
        return d`📝 scratchpad:\n${withCode(d`${tail}`)}`;
      }
      break;
    }
    case "spawn_subagents": {
      const input = SpawnSubagents.parsePartialSpawnSubagentsInput(
        streamingBlock.inputJson,
      );
      return d`🤖 spawn_subagents:\n${renderSpawnLayout(input)}`;
    }
    case "bash_command": {
      const command = extractPartialJsonStringValue(
        streamingBlock.inputJson,
        "command",
      );
      if (command !== undefined) {
        return d`⚡\n${withCode(d`${abridgeStreamedText(command)}`)}`;
      }
      break;
    }
    case "edl": {
      const script = extractPartialJsonStringValue(
        streamingBlock.inputJson,
        "script",
      );
      if (script !== undefined) {
        const segments = splitScriptByFile(script);
        const lines = script.split("\n");
        const tail = lines.slice(-10).join("\n");
        if (segments.length > 0) {
          const fileList = segments.map((s) => `  ${s.path}`).join("\n");
          return d`📝 edl: editing ${String(segments.length)} file${segments.length !== 1 ? "s" : ""}:\n${fileList}\n${withCode(d`${tail}`)}`;
        }
        return d`📝 edl:\n${withCode(d`${tail}`)}`;
      }
      break;
    }
    default:
      assertUnreachable(name);
  }

  return d`Invoking tool ${streamingBlock.name}\n`;
}
