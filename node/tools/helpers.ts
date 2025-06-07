import * as GetFile from "./getFile";
import * as Insert from "./insert";
import * as Replace from "./replace";
import * as ListBuffers from "./listBuffers";
import * as ListDirectory from "./listDirectory";
import * as Hover from "./hover";
import * as FindReferences from "./findReferences";
import * as Diagnostics from "./diagnostics";
import * as BashCommand from "./bashCommand";
import * as ReplaceSelection from "./replace-selection-tool";
import * as InlineEdit from "./inline-edit-tool";
import * as ThreadTitle from "./thread-title";
import * as CompactThread from "./compact-thread";
import * as SpawnSubagent from "./spawn-subagent";
import * as YieldToParent from "./yield-to-parent";
import type { StreamingBlock } from "../providers/helpers";
import { d, type VDOMNode } from "../tea/view";
import type { ToolName } from "./tool-registry";
import { assertUnreachable } from "../utils/assertUnreachable";

export function validateInput(
  toolName: unknown,
  input: { [key: string]: unknown },
) {
  switch (toolName as ToolName) {
    case "get_file":
      return GetFile.validateInput(input);
    case "insert":
      return Insert.validateInput(input);
    case "replace":
      return Replace.validateInput(input);
    case "list_buffers":
      return ListBuffers.validateInput();
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
    case "compact_thread":
      return CompactThread.validateInput(input);
    case "spawn_subagent":
      return SpawnSubagent.validateInput(input);
    case "yield_to_parent":
      return YieldToParent.validateInput(input);
    default:
      throw new Error(`Unexpected toolName: ${toolName as string}`);
  }
}

export function renderStreamdedTool(
  streamingBlock: Extract<StreamingBlock, { type: "tool_use" }>,
): string | VDOMNode {
  const name = streamingBlock.name as ToolName;
  switch (name) {
    case "get_file":
      break;
    case "insert":
      return Insert.renderStreamedBlock(streamingBlock.streamed);
    case "replace":
      return Replace.renderStreamedBlock(streamingBlock.streamed);
    case "list_buffers":
    case "list_directory":
    case "hover":
    case "find_references":
    case "diagnostics":
    case "bash_command":
    case "inline_edit":
    case "replace_selection":
    case "thread_title":
    case "compact_thread":
    case "spawn_subagent":
    case "yield_to_parent":
      break;
    default:
      assertUnreachable(name);
  }

  return d`Invoking tool ${streamingBlock.name}`;
}
