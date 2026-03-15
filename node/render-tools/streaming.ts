import {
  type AgentStreamingBlock,
  assertUnreachable,
  extractPartialJsonStringValue,
  type StaticToolName,
} from "@magenta/core";
import { d, type VDOMNode, withCode } from "../tea/view.ts";

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
    case "use_skill":
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
