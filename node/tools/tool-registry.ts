export const STATIC_TOOL_NAMES = [
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
  "wait_for_subagents",
  "yield_to_parent",
] as const;

export type StaticToolName = (typeof STATIC_TOOL_NAMES)[number];

export const CHAT_STATIC_TOOL_NAMES: StaticToolName[] = [
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
  "wait_for_subagents",
];

export const SUBAGENT_STATIC_TOOL_NAMES: StaticToolName[] = [
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
