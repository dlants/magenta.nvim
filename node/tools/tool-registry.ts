import * as GetFile from "./getFile.ts";
import * as Insert from "./insert.ts";
import * as Replace from "./replace.ts";
import * as ListBuffers from "./listBuffers.ts";
import * as ListDirectory from "./listDirectory.ts";
import * as Hover from "./hover.ts";
import * as FindReferences from "./findReferences.ts";
import * as Diagnostics from "./diagnostics.ts";
import * as BashCommand from "./bashCommand.ts";
import * as InlineEdit from "./inline-edit-tool.ts";
import * as ReplaceSelection from "./replace-selection-tool.ts";
import * as ThreadTitle from "./thread-title.ts";
import * as CompactThread from "./compact-thread.ts";
import type { ProviderToolSpec } from "../providers/provider-types.ts";

export const ALL_TOOL_NAMES = [
  "get_file",
  "insert",
  "replace",
  "list_buffers",
  "list_directory",
  "hover",
  "find_references",
  "diagnostics",
  "bash_command",
  "inline_edit",
  "replace_selection",
  "thread_title",
  "compact_thread",
];

export type ToolName = (typeof ALL_TOOL_NAMES)[number];

export const TOOL_SPEC_MAP: Record<ToolName, ProviderToolSpec> = {
  get_file: GetFile.spec,
  insert: Insert.spec,
  replace: Replace.spec,
  list_buffers: ListBuffers.spec,
  list_directory: ListDirectory.spec,
  hover: Hover.spec,
  find_references: FindReferences.spec,
  diagnostics: Diagnostics.spec,
  bash_command: BashCommand.spec,
  inline_edit: InlineEdit.spec,
  replace_selection: ReplaceSelection.spec,
  thread_title: ThreadTitle.spec,
  compact_thread: CompactThread.spec,
};

export const CHAT_TOOL_NAMES: ToolName[] = [
  "get_file",
  "insert",
  "replace",
  "list_buffers",
  "list_directory",
  "hover",
  "find_references",
  "diagnostics",
  "bash_command",
];

export function getToolSpecs(toolNames: ToolName[]): ProviderToolSpec[] {
  return toolNames.map((toolName) => TOOL_SPEC_MAP[toolName]);
}
