import * as GetFileRender from "./getFile.ts";
import * as HoverRender from "./hover.ts";
import * as FindReferencesRender from "./findReferences.ts";
import * as DiagnosticsRender from "./diagnostics.ts";
import * as BashCommandRender from "./bashCommand.ts";
import * as ThreadTitleRender from "./thread-title.ts";
import * as SpawnSubagentRender from "./spawn-subagent.ts";
import * as SpawnForeachRender from "./spawn-foreach.ts";
import * as WaitForSubagentsRender from "./wait-for-subagents.ts";
import * as YieldToParentRender from "./yield-to-parent.ts";
import * as EdlRender from "./edl.ts";
import * as MCPToolRender from "./mcp-tool.ts";

import * as BashCommand from "../tools/bashCommand.ts";
import * as SpawnSubagent from "../tools/spawn-subagent.ts";
import * as SpawnForeach from "../tools/spawn-foreach.ts";
import * as WaitForSubagents from "../tools/wait-for-subagents.ts";

import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import type {
  ToolRequest,
  CompletedToolInfo,
  DisplayContext,
} from "../tools/types.ts";
import type {
  ProviderToolResult,
} from "../providers/provider-types.ts";
import type { StaticToolName } from "../tools/tool-registry.ts";
import { isMCPTool } from "../tools/mcp/manager.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { NvimCwd, HomeDir } from "../utils/files.ts";
import type { MagentaOptions } from "../options.ts";
import type { Chat } from "../chat/chat.ts";

export type RenderContext = {
  getDisplayWidth: () => number;
  nvim: Nvim;
  cwd: NvimCwd;
  homeDir: HomeDir;
  options: MagentaOptions;
  dispatch: Dispatch<RootMsg>;
  chat?: Chat;
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
    return MCPToolRender.renderInFlightSummary(
      request,
      displayContext,
      progress as MCPToolRender.MCPProgress | undefined,
    );
  }

  switch (toolName) {
    case "get_file":
      return GetFileRender.renderInFlightSummary(request, displayContext);
    case "hover":
      return HoverRender.renderInFlightSummary(request, displayContext);
    case "find_references":
      return FindReferencesRender.renderInFlightSummary(
        request,
        displayContext,
      );
    case "diagnostics":
      return DiagnosticsRender.renderInFlightSummary(request, displayContext);
    case "thread_title":
      return ThreadTitleRender.renderInFlightSummary(request, displayContext);
    case "edl":
      return EdlRender.renderInFlightSummary(request, displayContext);
    case "bash_command":
      return BashCommandRender.renderInFlightSummary(
        request,
        displayContext,
        progress as BashCommand.BashProgress | undefined,
      );
    case "spawn_subagent":
      return SpawnSubagentRender.renderInFlightSummary(
        request,
        displayContext,
        progress as SpawnSubagent.SpawnSubagentProgress | undefined,
      );
    case "spawn_foreach":
      return SpawnForeachRender.renderInFlightSummary(
        request,
        displayContext,
        progress as SpawnForeach.SpawnForeachProgress | undefined,
      );
    case "wait_for_subagents":
      return WaitForSubagentsRender.renderInFlightSummary(
        request,
        displayContext,
        progress as WaitForSubagents.WaitForSubagentsProgress | undefined,
      );
    case "yield_to_parent":
      return YieldToParentRender.renderInFlightSummary(request, displayContext);
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
      return BashCommandRender.renderInFlightPreview(
        progress as BashCommand.BashProgress,
        context.getDisplayWidth,
      );
    case "spawn_subagent":
      return SpawnSubagentRender.renderInFlightPreview(
        request,
        progress as SpawnSubagent.SpawnSubagentProgress | undefined,
        context,
      );
    case "spawn_foreach":
      return SpawnForeachRender.renderInFlightPreview(
        request,
        progress as SpawnForeach.SpawnForeachProgress | undefined,
        context,
      );
    case "wait_for_subagents":
      return WaitForSubagentsRender.renderInFlightPreview(
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
      return BashCommandRender.renderInFlightDetail(
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
  chat?: Chat,
): VDOMNode {
  const toolName = info.request.toolName as StaticToolName;

  if (isMCPTool(toolName)) {
    return MCPToolRender.renderCompletedSummary(info, displayContext);
  }

  switch (toolName) {
    case "get_file":
      return GetFileRender.renderCompletedSummary(info, displayContext);
    case "bash_command":
      return BashCommandRender.renderCompletedSummary(info);
    case "hover":
      return HoverRender.renderCompletedSummary(info, displayContext);
    case "find_references":
      return FindReferencesRender.renderCompletedSummary(info, displayContext);
    case "diagnostics":
      return DiagnosticsRender.renderCompletedSummary(info);
    case "spawn_subagent":
      return SpawnSubagentRender.renderCompletedSummary(info, dispatch, chat);
    case "spawn_foreach":
      return SpawnForeachRender.renderCompletedSummary(info, dispatch);
    case "wait_for_subagents":
      return WaitForSubagentsRender.renderCompletedSummary(info, dispatch);
    case "yield_to_parent":
      return YieldToParentRender.renderCompletedSummary(info);
    case "thread_title":
      return ThreadTitleRender.renderCompletedSummary(info);
    case "edl":
      return EdlRender.renderCompletedSummary(info);
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
      return BashCommandRender.renderCompletedPreview(info, context);
    case "spawn_subagent":
      return SpawnSubagentRender.renderCompletedPreview(info);
    case "spawn_foreach":
      return SpawnForeachRender.renderCompletedPreview(info);
    case "edl":
      return EdlRender.renderCompletedPreview(info);
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
      return GetFileRender.renderCompletedDetail(info);
    case "bash_command":
      return BashCommandRender.renderCompletedDetail(info, context);
    case "spawn_subagent":
      return SpawnSubagentRender.renderCompletedDetail(info);
    case "spawn_foreach":
      return SpawnForeachRender.renderCompletedDetail(info, context.dispatch);
    case "edl":
      return EdlRender.renderCompletedDetail(info);
    default:
      return d`${JSON.stringify(info.request.input, null, 2)}`;
  }
}