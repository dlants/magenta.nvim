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
import { d, type VDOMNode } from "../tea/view.ts";
import type { HomeDir } from "../utils/files.ts";
import type {
  ToolRequestId,
  ToolRequest,
  CompletedToolInfo,
  DisplayContext,
} from "./types.ts";
import type {
  ProviderToolSpec,
  ProviderToolResult,
} from "../providers/provider-types.ts";
import {
  CHAT_STATIC_TOOL_NAMES,
  COMPACT_STATIC_TOOL_NAMES,
  SUBAGENT_STATIC_TOOL_NAMES,
  type StaticToolName,
} from "./tool-registry.ts";
import type { ThreadId, ThreadType } from "../chat/types.ts";
import { isMCPTool, type MCPToolManager } from "./mcp/manager.ts";
import * as MCPTool from "./mcp/tool.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
export type { ToolRequestId, CompletedToolInfo } from "./types.ts";

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

// ============================================================================
// Tool Renderers
// ============================================================================

type RenderContext = {
  getDisplayWidth: () => number;
  nvim: import("../nvim/nvim-node").Nvim;
  cwd: import("../utils/files.ts").NvimCwd;
  homeDir: HomeDir;
  options: import("../options.ts").MagentaOptions;
  dispatch: Dispatch<RootMsg>;
  chat?: import("../chat/chat.ts").Chat;
};

function isError(result: ProviderToolResult): boolean {
  return result.result.status === "error";
}

export function renderInFlightToolSummary(
  request: ToolRequest,
  displayContext: DisplayContext,
  progress?: unknown,
): VDOMNode {
  const toolName = request.toolName as StaticToolName;

  if (isMCPTool(toolName)) {
    return MCPTool.renderInFlightSummary(
      request,
      displayContext,
      progress as MCPTool.MCPProgress | undefined,
    );
  }

  switch (toolName) {
    case "get_file":
      return GetFile.renderInFlightSummary(request, displayContext);
    case "hover":
      return Hover.renderInFlightSummary(request, displayContext);
    case "find_references":
      return FindReferences.renderInFlightSummary(request, displayContext);
    case "diagnostics":
      return Diagnostics.renderInFlightSummary(request, displayContext);
    case "thread_title":
      return ThreadTitle.renderInFlightSummary(request, displayContext);
    case "edl":
      return Edl.renderInFlightSummary(request, displayContext);
    case "bash_command":
      return BashCommand.renderInFlightSummary(
        request,
        displayContext,
        progress as BashCommand.BashProgress | undefined,
      );
    case "spawn_subagent":
      return SpawnSubagent.renderInFlightSummary(
        request,
        displayContext,
        progress as SpawnSubagent.SpawnSubagentProgress | undefined,
      );
    case "spawn_foreach":
      return SpawnForeach.renderInFlightSummary(
        request,
        displayContext,
        progress as SpawnForeach.SpawnForeachProgress | undefined,
      );
    case "wait_for_subagents":
      return WaitForSubagents.renderInFlightSummary(
        request,
        displayContext,
        progress as WaitForSubagents.WaitForSubagentsProgress | undefined,
      );
    case "yield_to_parent":
      return YieldToParent.renderInFlightSummary(request, displayContext);
    default:
      assertUnreachable(toolName);
  }
}

export function renderInFlightToolPreview(
  request: ToolRequest,
  progress: unknown,
  context: RenderContext,
): VDOMNode {
  const toolName = request.toolName as StaticToolName;
  switch (toolName) {
    case "bash_command":
      return BashCommand.renderInFlightPreview(
        progress as BashCommand.BashProgress,
        context.getDisplayWidth,
      );
    case "spawn_subagent":
      return SpawnSubagent.renderInFlightPreview(
        request,
        progress as SpawnSubagent.SpawnSubagentProgress | undefined,
        context,
      );
    case "spawn_foreach":
      return SpawnForeach.renderInFlightPreview(
        request,
        progress as SpawnForeach.SpawnForeachProgress | undefined,
        context,
      );
    case "wait_for_subagents":
      return WaitForSubagents.renderInFlightPreview(
        request,
        progress as WaitForSubagents.WaitForSubagentsProgress | undefined,
        context,
      );
    default:
      return d``;
  }
}

export function renderInFlightToolDetail(
  request: ToolRequest,
  progress: unknown,
  context: RenderContext,
): VDOMNode {
  const toolName = request.toolName as StaticToolName;
  switch (toolName) {
    case "bash_command":
      return BashCommand.renderInFlightDetail(
        progress as BashCommand.BashProgress,
        context,
      );
    default:
      return d`${JSON.stringify(request.input, null, 2)}`;
  }
}

export function renderCompletedToolSummary(
  info: CompletedToolInfo,
  dispatch: Dispatch<RootMsg>,
  displayContext: DisplayContext,
  chat?: import("../chat/chat.ts").Chat,
): VDOMNode {
  const toolName = info.request.toolName as StaticToolName;

  if (isMCPTool(toolName)) {
    return MCPTool.renderCompletedSummary(info, displayContext);
  }

  switch (toolName) {
    case "get_file":
      return GetFile.renderCompletedSummary(info, displayContext);

    case "bash_command":
      return BashCommand.renderCompletedSummary(info);
    case "hover":
      return Hover.renderCompletedSummary(info, displayContext);
    case "find_references":
      return FindReferences.renderCompletedSummary(info, displayContext);
    case "diagnostics":
      return Diagnostics.renderCompletedSummary(info);
    case "spawn_subagent":
      return SpawnSubagent.renderCompletedSummary(info, dispatch, chat);
    case "spawn_foreach":
      return SpawnForeach.renderCompletedSummary(info, dispatch);
    case "wait_for_subagents":
      return WaitForSubagents.renderCompletedSummary(info, dispatch);
    case "yield_to_parent":
      return YieldToParent.renderCompletedSummary(info);
    case "thread_title":
      return ThreadTitle.renderCompletedSummary(info);
    case "edl":
      return Edl.renderCompletedSummary(info);
    default:
      assertUnreachable(toolName);
  }
}

export function renderCompletedToolPreview(
  info: CompletedToolInfo,
  context: RenderContext,
): VDOMNode {
  const toolName = info.request.toolName as StaticToolName;

  if (isError(info.result)) {
    return d``;
  }

  switch (toolName) {
    case "bash_command":
      return BashCommand.renderCompletedPreview(info, context);
    case "spawn_subagent":
      return SpawnSubagent.renderCompletedPreview(info);
    case "spawn_foreach":
      return SpawnForeach.renderCompletedPreview(info);
    case "edl":
      return Edl.renderCompletedPreview(info);
    default:
      return d``;
  }
}

export function renderCompletedToolDetail(
  info: CompletedToolInfo,
  context: RenderContext,
): VDOMNode {
  const toolName = info.request.toolName as StaticToolName;

  switch (toolName) {
    case "get_file":
      return GetFile.renderCompletedDetail(info);
    case "bash_command":
      return BashCommand.renderCompletedDetail(info, context);
    case "spawn_subagent":
      return SpawnSubagent.renderCompletedDetail(info);
    case "spawn_foreach":
      return SpawnForeach.renderCompletedDetail(info, context.dispatch);
    case "edl":
      return Edl.renderCompletedDetail(info);
    default:
      return d`${JSON.stringify(info.request.input, null, 2)}`;
  }
}
