export const STATIC_TOOL_NAMES = [
  "get_file",
  "insert",
  "replace",
  "list_directory",
  "hover",
  "find_references",
  "diagnostics",
  "bash_command",
  "inline_edit",
  "replace_selection",
  "thread_title",
  "spawn_subagent",
  "spawn_foreach",
  "wait_for_subagents",
  "yield_to_parent",
  "predict_edit",
  "compact",
  "search_pkb",
] as const;

export type StaticToolName = (typeof STATIC_TOOL_NAMES)[number];

export const CHAT_STATIC_TOOL_NAMES: StaticToolName[] = [
  "get_file",
  "insert",
  "replace",
  "list_directory",
  "hover",
  "find_references",
  "diagnostics",
  "bash_command",
  "spawn_subagent",
  "spawn_foreach",
  "wait_for_subagents",
  "compact",
];

export const SUBAGENT_STATIC_TOOL_NAMES: StaticToolName[] = [
  "get_file",
  "insert",
  "replace",
  "list_directory",
  "hover",
  "find_references",
  "diagnostics",
  "bash_command",
  "yield_to_parent",
];
