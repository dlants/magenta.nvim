export const STATIC_TOOL_NAMES = [
  "get_file",
  "hover",
  "find_references",
  "diagnostics",
  "bash_command",
  "thread_title",
  "spawn_subagent",
  "spawn_foreach",
  "wait_for_subagents",
  "yield_to_parent",
  "edl",
] as const;

export type StaticToolName = (typeof STATIC_TOOL_NAMES)[number];

export const CHAT_STATIC_TOOL_NAMES: StaticToolName[] = [
  "get_file",
  "hover",
  "find_references",
  "diagnostics",
  "bash_command",
  "spawn_subagent",
  "spawn_foreach",
  "wait_for_subagents",
  "edl",
];

export const COMPACT_STATIC_TOOL_NAMES: StaticToolName[] = ["edl"];
export const SUBAGENT_STATIC_TOOL_NAMES: StaticToolName[] = [
  "get_file",
  "hover",
  "find_references",
  "diagnostics",
  "bash_command",
  "yield_to_parent",
  "edl",
];
