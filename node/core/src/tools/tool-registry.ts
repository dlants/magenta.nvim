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
  "use_skill",
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
  "use_skill",
];

export const COMPACT_STATIC_TOOL_NAMES: StaticToolName[] = ["get_file", "edl"];
export const DOCKER_ROOT_STATIC_TOOL_NAMES: StaticToolName[] = [
  ...CHAT_STATIC_TOOL_NAMES,
  "yield_to_parent",
];
export const SUBAGENT_STATIC_TOOL_NAMES: StaticToolName[] = [
  "get_file",
  "hover",
  "find_references",
  "diagnostics",
  "bash_command",
  "yield_to_parent",
  "edl",
  "use_skill",
];

export const TOOL_CAPABILITIES = [
  "lsp",
  "shell",
  "diagnostics",
  "threads",
  "file-io",
] as const;

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

export const TOOL_REQUIRED_CAPABILITIES: Record<
  StaticToolName,
  Set<ToolCapability>
> = {
  get_file: new Set(["file-io"]),
  edl: new Set(["file-io"]),
  hover: new Set(["lsp"]),
  find_references: new Set(["lsp"]),
  diagnostics: new Set(["diagnostics"]),
  bash_command: new Set(["shell"]),
  spawn_subagent: new Set(["threads"]),
  spawn_foreach: new Set(["threads"]),
  wait_for_subagents: new Set(["threads"]),
  thread_title: new Set(),
  yield_to_parent: new Set(),
  use_skill: new Set(["shell"]),
};
