import type { ThreadId, ThreadType } from "../chat-types.ts";
import type { ToolSkillConfig } from "../provider-options.ts";
import type {
  ProviderToolSpec as MCPProviderToolSpec,
  ProviderToolSpec,
} from "../providers/provider-types.ts";
import type { ToolRequest, ToolRequestId } from "../tool-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import * as BashCommand from "./bashCommand.ts";
import * as Diagnostics from "./diagnostics.ts";
import * as Edl from "./edl.ts";
import * as FindReferences from "./findReferences.ts";
import * as GetFile from "./getFile.ts";
import * as Hover from "./hover.ts";
import * as SpawnForeach from "./spawn-foreach.ts";
import * as SpawnSubagent from "./spawn-subagent.ts";
import * as ThreadTitle from "./thread-title.ts";
import {
  CHAT_STATIC_TOOL_NAMES,
  COMPACT_STATIC_TOOL_NAMES,
  DOCKER_ROOT_STATIC_TOOL_NAMES,
  type StaticToolName,
  SUBAGENT_STATIC_TOOL_NAMES,
  TOOL_REQUIRED_CAPABILITIES,
  type ToolCapability,
} from "./tool-registry.ts";
import * as UseSkill from "./useSkill.ts";
import * as WaitForSubagents from "./wait-for-subagents.ts";
import * as YieldToParent from "./yield-to-parent.ts";

export type { CompletedToolInfo, ToolRequestId } from "../tool-types.ts";

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
  use_skill: { input: UseSkill.Input };
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
  use_skill: UseSkill.spec,
};

export function getToolSpecs(
  threadType: ThreadType,
  mcpToolManager: MCPToolManager,
  availableCapabilities?: Set<ToolCapability>,
  toolSkills?: ToolSkillConfig[],
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
    case "docker_root":
      staticToolNames = DOCKER_ROOT_STATIC_TOOL_NAMES;
      break;
    case "root":
    case "conductor":
      staticToolNames = CHAT_STATIC_TOOL_NAMES;
      break;
    default:
      assertUnreachable(threadType);
  }

  const hasSkills = toolSkills !== undefined && toolSkills.length > 0;

  const filteredToolNames =
    availableCapabilities !== undefined
      ? staticToolNames.filter((toolName) => {
          if (toolName === "use_skill" && !hasSkills) {
            return false;
          }
          const required = TOOL_REQUIRED_CAPABILITIES[toolName];
          for (const cap of required) {
            if (!availableCapabilities.has(cap)) {
              return false;
            }
          }
          return true;
        })
      : hasSkills
        ? staticToolNames
        : staticToolNames.filter((n) => n !== "use_skill");

  return [
    ...filteredToolNames.map((toolName) => {
      if (toolName === "use_skill" && hasSkills) {
        return UseSkill.getSpec(toolSkills);
      }
      return TOOL_SPEC_MAP[toolName];
    }),
    ...mcpToolManager.getToolSpecs(),
  ];
}
