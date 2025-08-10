import * as GetFile from "./getFile";
import * as Insert from "./insert";
import * as Replace from "./replace";

import * as ListDirectory from "./listDirectory";
import * as Hover from "./hover";
import * as FindReferences from "./findReferences";
import * as Diagnostics from "./diagnostics";
import * as BashCommand from "./bashCommand";
import * as ReplaceSelection from "./replace-selection-tool";
import * as InlineEdit from "./inline-edit-tool";
import * as ThreadTitle from "./thread-title";
import * as ForkThread from "./fork-thread";
import * as SpawnSubagent from "./spawn-subagent";
import * as SpawnForeach from "./spawn-foreach";
import * as WaitForSubagents from "./wait-for-subagents";
import * as YieldToParent from "./yield-to-parent";
import * as PredictEdit from "./predict-edit";
import type { StreamingBlock } from "../providers/helpers";
import { d, type VDOMNode } from "../tea/view";
import type { StaticToolName } from "./tool-registry";
import { assertUnreachable } from "../utils/assertUnreachable";

export function validateInput(
  toolName: unknown,
  input: { [key: string]: unknown },
) {
  const toolNameStr = toolName as string;

  // Handle MCP tools
  if (toolNameStr.startsWith("mcp_")) {
    return {
      status: "ok" as const,
      value: input,
    };
  }

  switch (toolName as StaticToolName) {
    case "get_file":
      return GetFile.validateInput(input);
    case "insert":
      return Insert.validateInput(input);
    case "replace":
      return Replace.validateInput(input);
    case "list_directory":
      return ListDirectory.validateInput(input);
    case "hover":
      return Hover.validateInput(input);
    case "find_references":
      return FindReferences.validateInput(input);
    case "diagnostics":
      return Diagnostics.validateInput();
    case "bash_command":
      return BashCommand.validateInput(input);
    case "inline_edit":
      return InlineEdit.validateInput(input);
    case "replace_selection":
      return ReplaceSelection.validateInput(input);
    case "thread_title":
      return ThreadTitle.validateInput(input);
    case "fork_thread":
      return ForkThread.validateInput(input);
    case "spawn_foreach":
      return SpawnForeach.validateInput(input);
    case "spawn_subagent":
      return SpawnSubagent.validateInput(input);
    case "wait_for_subagents":
      return WaitForSubagents.validateInput(input);
    case "yield_to_parent":
      return YieldToParent.validateInput(input);
    case "predict_edit":
      return PredictEdit.validateInput(input);
    default:
      throw new Error(`Unexpected toolName: ${toolName as string}`);
  }
}

export function renderStreamdedTool(
  streamingBlock: Extract<StreamingBlock, { type: "tool_use" }>,
): string | VDOMNode {
  if (streamingBlock.name.startsWith("mcp_")) {
    return d`Invoking mcp tool ${streamingBlock.name}`;
  }

  const name = streamingBlock.name as StaticToolName;
  switch (name) {
    case "get_file":
      break;
    case "insert":
      return Insert.renderStreamedBlock(streamingBlock.streamed);
    case "replace":
      return Replace.renderStreamedBlock(streamingBlock.streamed);
    case "list_directory":
    case "hover":
    case "find_references":
    case "diagnostics":
    case "bash_command":
    case "inline_edit":
    case "replace_selection":
    case "thread_title":
    case "fork_thread":
    case "spawn_subagent":
    case "wait_for_subagents":
    case "yield_to_parent":
    case "spawn_foreach":
    case "predict_edit":
      break;
    default:
      assertUnreachable(name);
  }

  return d`Invoking tool ${streamingBlock.name}`;
}
