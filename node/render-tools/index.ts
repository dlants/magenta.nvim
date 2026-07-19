import {
  type BashCommand,
  type CompletedToolInfo,
  type DisplayContext,
  isMCPTool,
  type RunScript,
  type SpawnSubagents,
  type StaticToolName,
  type ToolRequest,
  type ToolRequestId,
} from "@magenta/core";
import type { Chat } from "../chat/chat.ts";
import type { Msg as ThreadMsg, ToolViewState } from "../chat/thread.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { MagentaOptions } from "../options.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";
import type { RootMsg } from "../root-msg.ts";
import type { Dispatch } from "../tea/tea.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import { formatTokens } from "../utils/tokens.ts";
import * as BashCommandRender from "./bashCommand.ts";
import * as DocsRender from "./docs.ts";
import * as EdlRender from "./edl.ts";
import * as FindReferencesRender from "./findReferences.ts";
import * as GetFileRender from "./getFile.ts";
import * as HoverRender from "./hover.ts";
import * as MCPToolRender from "./mcp-tool.ts";
import * as NvimLuaRender from "./nvimLua.ts";
import * as RunScriptRender from "./run-script.ts";
import * as ScratchpadRender from "./scratchpad.ts";
import * as SpawnSubagentsRender from "./spawn-subagents.ts";
import * as ThreadTitleRender from "./thread-title.ts";

import * as YieldToParentRender from "./yield-to-parent.ts";

export type RenderContext = {
  getDisplayWidth: () => number;
  nvim: Nvim;
  cwd: NvimCwd;
  homeDir: HomeDir;
  options: MagentaOptions;
  dispatch: Dispatch<RootMsg>;
  threadDispatch: Dispatch<ThreadMsg>;
  chat: Chat;
};

function isError(result: ProviderToolResult): boolean {
  return result.result.status === "error";
}

function formatTokenEstimate(result: ProviderToolResult): string {
  const content =
    result.result.status === "error"
      ? result.result.error
      : JSON.stringify(result.result.value);
  return formatTokens(content.length);
}

export function renderToolSummary(
  request: ToolRequest,
  displayContext: DisplayContext,
): VDOMNode {
  const toolName = request.toolName as StaticToolName;

  if (isMCPTool(toolName)) {
    return MCPToolRender.renderSummary(request, displayContext);
  }

  switch (toolName) {
    case "get_files":
      return GetFileRender.renderSummary(request, displayContext);
    case "hover":
      return HoverRender.renderSummary(request, displayContext);
    case "find_references":
      return FindReferencesRender.renderSummary(request, displayContext);
    case "thread_title":
      return ThreadTitleRender.renderSummary(request, displayContext);
    case "edl":
      return EdlRender.renderSummary(request, displayContext);
    case "bash_command":
      return BashCommandRender.renderSummary(request, displayContext);
    case "spawn_subagents":
      return SpawnSubagentsRender.renderSummary(request, displayContext);
    case "yield_to_parent":
      return YieldToParentRender.renderSummary(request, displayContext);
    case "docs":
      return DocsRender.renderSummary(request, displayContext);
    case "run_script": {
      const input = request.input as RunScript.Input;
      return d`🚀 run_script: ${input.scriptName}`;
    }
    case "nvim_lua":
      return NvimLuaRender.renderSummary(request, displayContext);
    case "scratchpad":
      return ScratchpadRender.renderSummary(request, displayContext);
    default:
      assertUnreachable(toolName);
  }
}

export function renderToolInput(
  request: ToolRequest,
  displayContext: DisplayContext,
  expanded: boolean,
  inFlight: boolean,
): VDOMNode | undefined {
  const toolName = request.toolName as StaticToolName;

  if (isMCPTool(toolName)) {
    return undefined;
  }

  switch (toolName) {
    case "bash_command":
      return BashCommandRender.renderInput(request, displayContext, expanded);
    case "edl":
      return EdlRender.renderInput(request, displayContext, expanded, inFlight);
    case "nvim_lua":
      return NvimLuaRender.renderInput(request, displayContext, expanded);
    case "scratchpad":
      return ScratchpadRender.renderInput(request, displayContext, expanded);
    case "spawn_subagents":
      return SpawnSubagentsRender.renderInput(
        request,
        displayContext,
        expanded,
      );
    default:
      return undefined;
  }
}

export function renderToolInputSummaryExpansion(
  request: ToolRequest,
): VDOMNode | undefined {
  const toolName = request.toolName as StaticToolName;
  switch (toolName) {
    case "edl":
      return EdlRender.renderInputSummary(request);
    default:
      return undefined;
  }
}

export function renderToolResultSummaryExpansion(
  info: CompletedToolInfo,
): VDOMNode | undefined {
  const toolName = info.request.toolName as StaticToolName;
  switch (toolName) {
    case "edl":
      return EdlRender.renderResultSummaryExpansion(info);
    default:
      return undefined;
  }
}

export function renderToolProgress(
  request: ToolRequest,
  progress: unknown,
  context: RenderContext,
  expanded: boolean,
  toolViewState: ToolViewState,
  toolRequestId: ToolRequestId,
): VDOMNode | undefined {
  const toolName = request.toolName as StaticToolName;

  if (isMCPTool(toolName)) {
    return MCPToolRender.renderProgress(
      request,
      progress as MCPToolRender.MCPProgress,
      context,
      expanded,
    );
  }

  switch (toolName) {
    case "bash_command":
      return BashCommandRender.renderProgress(
        request,
        progress as BashCommand.BashProgress,
        context,
        expanded,
      );
    case "spawn_subagents":
      return SpawnSubagentsRender.renderProgress(
        request,
        progress as SpawnSubagents.SpawnSubagentsProgress | undefined,
        context,
        expanded,
        toolViewState,
        toolRequestId,
      );
    default:
      return undefined;
  }
}

export function renderToolResultSummary(
  info: CompletedToolInfo,
  displayContext: DisplayContext,
): VDOMNode {
  const statusEmoji = isError(info.result) ? "❌" : "✅";
  const toolName = info.request.toolName as StaticToolName;

  const tokEst = formatTokenEstimate(info.result);

  if (isMCPTool(toolName)) {
    return d`${statusEmoji} ${MCPToolRender.renderResultSummary(info, displayContext)} (${tokEst})`;
  }

  switch (toolName) {
    case "get_files":
      return GetFileRender.renderResultSummary(info, displayContext);
    case "bash_command":
      return d`${statusEmoji} ${BashCommandRender.renderResultSummary(info)} (${tokEst})`;
    case "hover":
      return d`${statusEmoji} ${HoverRender.renderResultSummary(info, displayContext)} (${tokEst})`;
    case "find_references":
      return d`${statusEmoji} ${FindReferencesRender.renderResultSummary(info, displayContext)} (${tokEst})`;
    case "spawn_subagents":
      return d`${statusEmoji} ${SpawnSubagentsRender.renderResultSummary(info)} (${tokEst})`;
    case "yield_to_parent":
      return d`${statusEmoji} ${YieldToParentRender.renderResultSummary(info)} (${tokEst})`;
    case "docs":
      return d`${statusEmoji} ${DocsRender.renderResultSummary(info)} (${tokEst})`;
    case "thread_title":
      return d`${statusEmoji} ${ThreadTitleRender.renderResultSummary(info)}`;
    case "edl":
      return d`${statusEmoji} ${EdlRender.renderResultSummary(info)} (${tokEst})`;
    case "run_script":
      return d`${statusEmoji} run_script (${tokEst})`;
    case "nvim_lua":
      return d`${statusEmoji} nvim_lua (${tokEst})`;
    case "scratchpad":
      return d`${statusEmoji} scratchpad (${tokEst})`;
    default:
      assertUnreachable(toolName);
  }
}

export function renderToolResult(
  info: CompletedToolInfo,
  context: RenderContext,
  toolViewState: ToolViewState,
  toolRequestId: ToolRequestId,
): VDOMNode | undefined {
  const toolName = info.request.toolName as StaticToolName;

  switch (toolName) {
    case "bash_command":
      return BashCommandRender.renderResult(
        info,
        context,
        toolViewState,
        toolRequestId,
      );
    case "run_script":
      return RunScriptRender.renderResult(info, context);
    case "spawn_subagents":
      return SpawnSubagentsRender.renderResult(
        info,
        context,
        toolViewState,
        toolRequestId,
      );
    case "edl":
      return EdlRender.renderResult(
        info,
        context,
        toolViewState,
        toolRequestId,
      );
    case "docs":
      return DocsRender.renderResult(
        info,
        context,
        toolViewState,
        toolRequestId,
      );
    case "get_files":
      return GetFileRender.renderResult(
        info,
        context,
        toolViewState,
        toolRequestId,
      );
    default:
      return toolViewState.resultExpanded
        ? d`${JSON.stringify(info.request.input, null, 2)}`
        : undefined;
  }
}
