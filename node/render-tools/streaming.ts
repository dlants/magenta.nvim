import { d, withCode, type VDOMNode } from "../tea/view.ts";
import {
  extractPartialJsonStringValue,
  assertUnreachable,
  type StaticToolName,
  type AgentStreamingBlock,
} from "@magenta/core";

export function renderStreamdedTool(
  streamingBlock: Extract<AgentStreamingBlock, { type: "tool_use" }>,
): string | VDOMNode {
  if (streamingBlock.name.startsWith("mcp_")) {
    return d`Invoking mcp tool ${streamingBlock.name}`;
  }

  const name = streamingBlock.name as StaticToolName;
  switch (name) {
    case "get_file":
    case "hover":
    case "find_references":
    case "diagnostics":
    case "bash_command":
    case "thread_title":
    case "spawn_subagent":
    case "wait_for_subagents":
    case "yield_to_parent":
    case "spawn_foreach":
      break;
    case "edl": {
      const script = extractPartialJsonStringValue(
        streamingBlock.inputJson,
        "script",
      );
      if (script !== undefined) {
        return d`📝 edl:\n${withCode(d`${script}`)}`;
      }
      break;
    }
    default:
      assertUnreachable(name);
  }

  return d`Invoking tool ${streamingBlock.name}\n`;
}
