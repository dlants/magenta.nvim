import * as GetFile from "./getFile.ts";
import * as Insert from "./insert.ts";
import * as Replace from "./replace.ts";
import * as ListDirectory from "./listDirectory.ts";
import * as Hover from "./hover.ts";
import * as FindReferences from "./findReferences.ts";
import * as Diagnostics from "./diagnostics.ts";
import * as BashCommand from "./bashCommand.ts";
import * as InlineEdit from "./inline-edit-tool.ts";
import * as ReplaceSelection from "./replace-selection-tool.ts";
import * as ThreadTitle from "./thread-title.ts";
import * as SpawnSubagent from "./spawn-subagent.ts";
import * as SpawnForeach from "./spawn-foreach.ts";
import * as WaitForSubagents from "./wait-for-subagents.ts";
import * as YieldToParent from "./yield-to-parent.ts";
import * as PredictEdit from "./predict-edit.ts";
import * as Compact from "./compact.ts";
import * as SearchPkb from "./searchPkb.ts";

import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import type {
  ToolMsg,
  ToolRequestId,
  ToolRequest,
  ToolManagerToolMsg,
  CompletedToolInfo,
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
  insert: {
    controller: Insert.InsertTool;
    input: Insert.Input;
    msg: Insert.Msg;
    spec: typeof Insert.spec;
  };
  replace: {
    controller: Replace.ReplaceTool;
    input: Replace.Input;
    msg: Replace.Msg;
    spec: typeof Replace.spec;
  };

  list_directory: {
    controller: ListDirectory.ListDirectoryTool;
    input: ListDirectory.Input;
    msg: ListDirectory.Msg;
    spec: typeof ListDirectory.spec;
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
  inline_edit: {
    controller: InlineEdit.InlineEditTool;
    input: InlineEdit.Input;
    msg: InlineEdit.Msg;
    spec: typeof InlineEdit.spec;
  };
  replace_selection: {
    controller: ReplaceSelection.ReplaceSelectionTool;
    input: ReplaceSelection.Input;
    msg: ReplaceSelection.Msg;
    spec: typeof ReplaceSelection.spec;
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
  predict_edit: {
    controller: PredictEdit.PredictEditTool;
    input: PredictEdit.Input;
    msg: PredictEdit.Msg;
    spec: typeof PredictEdit.spec;
  };
  compact: {
    controller: Compact.CompactTool;
    input: Compact.Input;
    msg: Compact.Msg;
    spec: typeof Compact.spec;
  };
  search_pkb: {
    controller: SearchPkb.SearchPkbTool;
    input: SearchPkb.Input;
    msg: SearchPkb.Msg;
    spec: typeof SearchPkb.spec;
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
  insert: Insert.spec,
  replace: Replace.spec,
  list_directory: ListDirectory.spec,
  hover: Hover.spec,
  find_references: FindReferences.spec,
  diagnostics: Diagnostics.spec,
  bash_command: BashCommand.spec,
  inline_edit: InlineEdit.spec,
  replace_selection: ReplaceSelection.spec,
  thread_title: ThreadTitle.spec,
  spawn_subagent: SpawnSubagent.spec,
  spawn_foreach: SpawnForeach.spec,
  yield_to_parent: YieldToParent.spec,
  wait_for_subagents: WaitForSubagents.spec,
  predict_edit: PredictEdit.spec,
  compact: Compact.spec,
  search_pkb: SearchPkb.spec,
};

export function getToolSpecs(
  threadType: ThreadType,
  mcpToolManager: MCPToolManager,
  options?: { pkbEnabled?: boolean },
): ProviderToolSpec[] {
  let staticToolNames: StaticToolName[] = [];
  switch (threadType) {
    case "subagent_default":
    case "subagent_fast":
      staticToolNames = SUBAGENT_STATIC_TOOL_NAMES;
      break;
    case "root":
      staticToolNames = CHAT_STATIC_TOOL_NAMES;
      break;
    default:
      assertUnreachable(threadType);
  }

  const specs = staticToolNames.map((toolName) => TOOL_SPEC_MAP[toolName]);

  // Add search_pkb tool if PKB is enabled
  if (options?.pkbEnabled) {
    specs.push(SearchPkb.spec);
  }

  return [...specs, ...mcpToolManager.getToolSpecs()];
}

// ============================================================================
// Tool Renderers
// ============================================================================

type RenderContext = {
  getDisplayWidth: () => number;
  nvim: import("../nvim/nvim-node").Nvim;
  cwd: import("../utils/files.ts").NvimCwd;
  options: import("../options.ts").MagentaOptions;
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
): VDOMNode {
  const toolName = info.request.toolName as StaticToolName;

  if (isMCPTool(toolName)) {
    return d`🔨${getStatusEmoji(info.result)} MCP tool \`${info.request.toolName}\``;
  }

  switch (toolName) {
    case "get_file":
      return GetFile.renderCompletedSummary(info);
    case "insert":
      return Insert.renderCompletedSummary(info);
    case "replace":
      return Replace.renderCompletedSummary(info);
    case "list_directory":
      return ListDirectory.renderCompletedSummary(info);
    case "bash_command":
      return BashCommand.renderCompletedSummary(info);
    case "hover":
      return Hover.renderCompletedSummary(info);
    case "find_references":
      return FindReferences.renderCompletedSummary(info);
    case "diagnostics":
      return Diagnostics.renderCompletedSummary(info);
    case "spawn_subagent":
      return SpawnSubagent.renderCompletedSummary(info, dispatch);
    case "spawn_foreach":
      return SpawnForeach.renderCompletedSummary(info, dispatch);
    case "wait_for_subagents":
      return WaitForSubagents.renderCompletedSummary(info, dispatch);
    case "yield_to_parent":
      return YieldToParent.renderCompletedSummary(info);
    case "thread_title":
      return ThreadTitle.renderCompletedSummary(info);
    case "inline_edit":
      return InlineEdit.renderCompletedSummary(info);
    case "replace_selection":
      return ReplaceSelection.renderCompletedSummary(info);
    case "predict_edit":
      return PredictEdit.renderCompletedSummary(info);
    case "compact":
      return Compact.renderCompletedSummary(info);
    case "search_pkb":
      return SearchPkb.renderCompletedSummary(info);
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
    case "insert":
      return Insert.renderInsertPreview(
        info.request.input as Insert.Input,
        context.getDisplayWidth(),
      );
    case "replace":
      return Replace.renderReplacePreview(
        info.request.input as Replace.Input,
        context.getDisplayWidth(),
      );
    case "bash_command":
      return BashCommand.renderCompletedPreview(info, context);
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
    case "insert":
      return Insert.renderInsertDetail(info.request.input as Insert.Input);
    case "replace":
      return Replace.renderReplaceDetail(info.request.input as Replace.Input);
    case "bash_command":
      return BashCommand.renderCompletedDetail(info, context);
    default:
      return d`${JSON.stringify(info.request.input, null, 2)}`;
  }
}
