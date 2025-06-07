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
  "spawn_subagent",
  "yield_to_parent",
] as const;

export type ToolName = (typeof ALL_TOOL_NAMES)[number];

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
  "spawn_subagent",
];

export const SUBAGENT_TOOL_NAMES: ToolName[] = [
  "get_file",
  "insert",
  "replace",
  "list_buffers",
  "list_directory",
  "hover",
  "find_references",
  "diagnostics",
  "bash_command",
  "yield_to_parent",
];
