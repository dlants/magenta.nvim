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
import * as Compact from "./compact.ts";
import * as Edl from "./edl.ts";

import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import type { HomeDir } from "../utils/files.ts";
import type {
  ToolMsg,
  ToolRequestId,
  ToolRequest,
  ToolManagerToolMsg,
  CompletedToolInfo,
  DisplayContext,
} from "./types.ts";
import type {
  ProviderToolSpec,
  ProviderToolResult,
} from "../providers/provider-types.ts";
import {
  CHAT_STATIC_TOOL_NAMES,
  SUBAGENT_STATIC_TOOL_NAMES,
  type StaticToolName,
} from "./tool-registry.ts";
import type { ThreadId, ThreadType } from "../chat/types.ts";
import { isMCPTool, type MCPToolManager } from "./mcp/manager.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
export type { Tool, ToolRequestId, CompletedToolInfo } from "./types.ts";

export type StaticToolMap = {
  get_file: {
    controller: GetFile.GetFileTool;
    input: GetFile.Input;
    msg: GetFile.Msg;
    spec: typeof GetFile.spec;
  };

  hover: {
    controller: Hover.HoverTool;
    input: Hover.Input;
    msg: Hover.Msg;
    spec: typeof Hover.spec;
  };
  find_references: {
    controller: FindReferences.FindReferencesTool;
    input: FindReferences.Input;
    msg: FindReferences.Msg;
    spec: typeof FindReferences.spec;
  };
  diagnostics: {
    controller: Diagnostics.DiagnosticsTool;
    input: Diagnostics.Input;
    msg: Diagnostics.Msg;
    spec: typeof Diagnostics.spec;
  };
  bash_command: {
    controller: BashCommand.BashCommandTool;
    input: BashCommand.Input;
    msg: BashCommand.Msg;
    spec: typeof BashCommand.spec;
  };
  thread_title: {
    controller: ThreadTitle.ThreadTitleTool;
    input: ThreadTitle.Input;
    msg: ThreadTitle.Msg;
    spec: typeof ThreadTitle.spec;
  };
  spawn_subagent: {
    controller: SpawnSubagent.SpawnSubagentTool;
    input: SpawnSubagent.Input;
    msg: SpawnSubagent.Msg;
    spec: typeof SpawnSubagent.spec;
  };
  spawn_foreach: {
    controller: SpawnForeach.SpawnForeachTool;
    input: SpawnForeach.Input;
    msg: SpawnForeach.Msg;
    spec: typeof SpawnForeach.spec;
  };
  wait_for_subagents: {
    controller: WaitForSubagents.WaitForSubagentsTool;
    input: WaitForSubagents.Input;
    msg: WaitForSubagents.Msg;
    spec: typeof WaitForSubagents.spec;
  };
  yield_to_parent: {
    controller: YieldToParent.YieldToParentTool;
    input: YieldToParent.Input;
    msg: YieldToParent.Msg;
    spec: typeof YieldToParent.spec;
  };
  compact: {
    controller: Compact.CompactTool;
    input: Compact.Input;
    msg: Compact.Msg;
    spec: typeof Compact.spec;
  };
  edl: {
    controller: Edl.EdlTool;
    input: Edl.Input;
    msg: Edl.Msg;
    spec: typeof Edl.spec;
  };
};

export type StaticToolRequest = {
  [K in keyof StaticToolMap]: {
    id: ToolRequestId;
    toolName: K;
    input: StaticToolMap[K]["input"];
  };
}[keyof StaticToolMap];

export function wrapStaticToolMsg(
  msg: StaticToolMap[keyof StaticToolMap]["msg"],
): ToolMsg {
  return msg as unknown as ToolMsg;
}

export function unwrapStaticToolMsg<
  StaticToolName extends keyof StaticToolMap = keyof StaticToolMap,
>(msg: ToolMsg): StaticToolMap[StaticToolName]["msg"] {
  return msg as unknown as StaticToolMap[StaticToolName]["msg"];
}

export type Msg =
  | {
      type: "init-tool-use";
      threadId: ThreadId;
      request: ToolRequest;
    }
  | ToolManagerToolMsg;

const TOOL_SPEC_MAP: {
  [K in StaticToolName]: ProviderToolSpec;
} = {
  get_file: GetFile.spec,

  hover: Hover.spec,
  find_references: FindReferences.spec,
  diagnostics: Diagnostics.spec,
  bash_command: BashCommand.spec,
  thread_title: ThreadTitle.spec,
  spawn_subagent: SpawnSubagent.spec,
  spawn_foreach: SpawnForeach.spec,
  yield_to_parent: YieldToParent.spec,
  wait_for_subagents: WaitForSubagents.spec,
  compact: Compact.spec,
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
};

function isError(result: ProviderToolResult): boolean {
  return result.result.status === "error";
}

function getStatusEmoji(result: ProviderToolResult): string {
  return isError(result) ? "❌" : "✅";
}

export function renderCompletedToolSummary(
  info: CompletedToolInfo,
  dispatch: Dispatch<RootMsg>,
  displayContext: DisplayContext,
  chat?: import("../chat/chat.ts").Chat,
): VDOMNode {
  const toolName = info.request.toolName as StaticToolName;

  if (isMCPTool(toolName)) {
    return d`🔨${getStatusEmoji(info.result)} MCP tool \`${info.request.toolName}\``;
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
    case "compact":
      return Compact.renderCompletedSummary(info);
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
