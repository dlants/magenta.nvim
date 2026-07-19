export const STATIC_TOOL_NAMES = [
  "get_files",
  "hover",
  "find_references",
  "bash_command",
  "thread_title",
  "spawn_subagents",
  "yield_to_parent",
  "edl",
  "run_script",
  "nvim_lua",
  "scratchpad",
] as const;

export type StaticToolName = (typeof STATIC_TOOL_NAMES)[number];

export const CHAT_STATIC_TOOL_NAMES: StaticToolName[] = [
  "get_files",
  "hover",
  "find_references",
  "bash_command",
  "spawn_subagents",
  "edl",
  "run_script",
  "nvim_lua",
  "scratchpad",
];

export const COMPACT_STATIC_TOOL_NAMES: StaticToolName[] = ["get_files", "edl"];
export const DOCKER_ROOT_STATIC_TOOL_NAMES: StaticToolName[] = [
  ...CHAT_STATIC_TOOL_NAMES,
  "yield_to_parent",
];
export const SUBAGENT_STATIC_TOOL_NAMES: StaticToolName[] = [
  "get_files",
  "hover",
  "find_references",
  "bash_command",
  "yield_to_parent",
  "edl",
  "scratchpad",
];

export const TOOL_CAPABILITIES = [
  "lsp",
  "shell",
  "threads",
  "file-io",
  "scripts",
  "nvim",
] as const;

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

export const TOOL_REQUIRED_CAPABILITIES: Record<
  StaticToolName,
  Set<ToolCapability>
> = {
  get_files: new Set(["file-io"]),
  edl: new Set(["file-io"]),
  hover: new Set(["lsp"]),
  find_references: new Set(["lsp"]),
  bash_command: new Set(["shell"]),
  spawn_subagents: new Set(["threads"]),
  thread_title: new Set(),
  yield_to_parent: new Set(),
  run_script: new Set(["scripts"]),
  nvim_lua: new Set(["nvim"]),
  scratchpad: new Set(),
};
