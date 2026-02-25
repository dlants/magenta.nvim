import * as GetFile from "./getFile.ts";

import * as Hover from "./hover.ts";
import * as FindReferences from "./findReferences.ts";
import * as Diagnostics from "./diagnostics.ts";
import * as BashCommand from "./bashCommand.ts";
import * as ThreadTitle from "./thread-title.ts";
import * as SpawnSubagent from "./spawn-subagent.ts";
import * as SpawnForeach from "./spawn-foreach.ts";
import * as WaitForSubagents from "./wait-for-subagents.ts";
import * as YieldToParent from "./yield-to-parent.ts";

import * as Edl from "./edl.ts";

import { assertUnreachable } from "../utils/assertUnreachable.ts";

import type { ToolRequestId, ToolRequest } from "../tool-types.ts";
import type { ProviderToolSpec } from "../providers/provider-types.ts";
import {
  CHAT_STATIC_TOOL_NAMES,
  COMPACT_STATIC_TOOL_NAMES,
  SUBAGENT_STATIC_TOOL_NAMES,
  type StaticToolName,
} from "./tool-registry.ts";
import type { ThreadId, ThreadType } from "../chat-types.ts";
import type { ProviderToolSpec as MCPProviderToolSpec } from "../providers/provider-types.ts";

export type { ToolRequestId, CompletedToolInfo } from "../tool-types.ts";

export interface MCPToolManager {
  getToolSpecs(): MCPProviderToolSpec[];
}

export type StaticToolMap = {
  get_file: { input: GetFile.Input };
  hover: { input: Hover.Input };
  find_references: { input: FindReferences.Input };
  diagnostics: { input: Diagnostics.Input };
  bash_command: { input: BashCommand.Input };
  thread_title: { input: ThreadTitle.Input };
  spawn_subagent: { input: SpawnSubagent.Input };
  spawn_foreach: { input: SpawnForeach.Input };
  wait_for_subagents: { input: WaitForSubagents.Input };
  yield_to_parent: { input: YieldToParent.Input };
  edl: { input: Edl.Input };
};

export type StaticToolRequest = {
  [K in keyof StaticToolMap]: {
    id: ToolRequestId;
    toolName: K;
    input: StaticToolMap[K]["input"];
  };
}[keyof StaticToolMap];

export type Msg = {
  type: "init-tool-use";
  threadId: ThreadId;
  request: ToolRequest;
};

const TOOL_SPEC_MAP: {
  [K in StaticToolName]: ProviderToolSpec;
} = {
  get_file: GetFile.spec,

  hover: Hover.spec,
  find_references: FindReferences.spec,

  bash_command: BashCommand.spec,
  diagnostics: Diagnostics.spec,
  thread_title: ThreadTitle.spec,
  spawn_subagent: SpawnSubagent.spec,
  spawn_foreach: SpawnForeach.spec,
  yield_to_parent: YieldToParent.spec,
  wait_for_subagents: WaitForSubagents.spec,

  edl: Edl.spec,
};

export function getToolSpecs(
  threadType: ThreadType,
  mcpToolManager: MCPToolManager,
): ProviderToolSpec[] {
  let staticToolNames: StaticToolName[] = [];
  switch (threadType) {
    case "subagent_default":
    case "subagent_fast":
    case "subagent_explore":
      staticToolNames = SUBAGENT_STATIC_TOOL_NAMES;
      break;
    case "compact":
      staticToolNames = COMPACT_STATIC_TOOL_NAMES;
      break;
    case "root":
      staticToolNames = CHAT_STATIC_TOOL_NAMES;
      break;
    default:
      assertUnreachable(threadType);
  }
  return [
    ...staticToolNames.map((toolName) => TOOL_SPEC_MAP[toolName]),
    ...mcpToolManager.getToolSpecs(),
  ];
}
