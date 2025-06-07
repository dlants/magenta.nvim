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
import * as SpawnSubagent from "./spawn-subagent.ts";
import * as YieldToParent from "./yield-to-parent.ts";
import type { ProviderToolSpec } from "../providers/provider-types.ts";
import type { ToolName } from "./tool-registry.ts";

export const TOOL_SPEC_MAP: { [K in ToolName]: ProviderToolSpec } = {
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
  spawn_subagent: SpawnSubagent.spec,
  yield_to_parent: YieldToParent.spec,
};

export function getToolSpecs(toolNames: ToolName[]): ProviderToolSpec[] {
  return toolNames.map((toolName) => TOOL_SPEC_MAP[toolName]);
}
