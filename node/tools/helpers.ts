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
import type { StreamingBlock } from "../providers/helpers";
import { d, type VDOMNode } from "../tea/view";

export function validateInput(
  toolName: unknown,
  input: { [key: string]: unknown },
) {
  switch (toolName) {
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
    default:
      throw new Error(`Unexpected toolName: ${toolName as string}`);
  }
}

export function renderStreamdedTool(
  streamingBlock: Extract<StreamingBlock, { type: "tool_use" }>,
): string | VDOMNode {
  switch (streamingBlock.name) {
    case "get_file":
      break;
    case "insert":
      return Insert.renderStreamedBlock(streamingBlock.streamed);
    case "replace":
      return Replace.renderStreamedBlock(streamingBlock.streamed);
    case "list_buffers":
      break;
    case "list_directory":
      break;
    case "hover":
      break;
    case "find_references":
      break;
    case "diagnostics":
      break;
    case "bash_command":
      break;
    case "inline_edit":
      break;
    case "replace_selection":
      break;
  }

  return d`Invoking tool ${streamingBlock.name}`;
}
