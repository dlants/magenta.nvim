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

import type { EdlRegisters } from "../edl/index.ts";

import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Lsp } from "../lsp.ts";
import type { MagentaOptions } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import type { Chat } from "../chat/chat.ts";
import type {
  ToolRequest,
  ToolMsg,
  Tool,
  ToolName,
  ToolRequestId,
  StaticTool,
} from "./types.ts";
import type { ThreadId } from "../chat/types.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { ContextManager } from "../context/context-manager.ts";
import type { Msg as ThreadMsg } from "../chat/thread.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import type { MCPToolManager } from "./mcp/manager.ts";
import { parseToolName, wrapMcpToolMsg } from "./mcp/types.ts";
import { MCPTool, type Input as MCPInput } from "./mcp/tool.ts";

export type CreateToolContext = {
  dispatch: Dispatch<RootMsg>;
  bufferTracker: BufferTracker;
  getDisplayWidth: () => number;
  threadId: ThreadId;
  nvim: Nvim;
  lsp: Lsp;
  mcpToolManager: MCPToolManager;
  cwd: NvimCwd;
  homeDir: HomeDir;
  options: MagentaOptions;
  chat: Chat;
  contextManager: ContextManager;
  threadDispatch: Dispatch<ThreadMsg>;
  edlRegisters: EdlRegisters;
};

export type ToolDispatch = (msg: {
  id: ToolRequestId;
  toolName: ToolName;
  msg: ToolMsg;
}) => void;

export function createTool(
  request: ToolRequest,
  context: CreateToolContext,
  myDispatch: ToolDispatch,
): Tool | StaticTool {
  if (request.toolName.startsWith("mcp_")) {
    const { serverName } = parseToolName(request.toolName);

    const mcpClient = context.mcpToolManager.serverMap[serverName].client;
    if (!mcpClient) {
      throw new Error(`${request.toolName} not found in any connected server`);
    }

    return new MCPTool(
      {
        id: request.id,
        toolName: request.toolName,
        input: request.input as MCPInput,
      },
      {
        nvim: context.nvim,
        mcpClient,
        myDispatch: (msg) =>
          myDispatch({
            id: request.id,
            toolName: request.toolName,
            msg: wrapMcpToolMsg(msg),
          }),
      },
    );
  }

  const staticRequest = request as StaticToolRequest;

  const wrapDispatch = <M>(msg: M): void => {
    myDispatch({
      id: request.id,
      toolName: request.toolName,
      msg: msg as unknown as ToolMsg,
    });
  };

  switch (staticRequest.toolName) {
    case "get_file": {
      return new GetFile.GetFileTool(staticRequest, {
        nvim: context.nvim,
        cwd: context.cwd,
        homeDir: context.homeDir,
        options: context.options,
        contextManager: context.contextManager,
        threadDispatch: context.threadDispatch,
        myDispatch: wrapDispatch,
      });
    }

    case "hover": {
      return new Hover.HoverTool(staticRequest, {
        ...context,
        myDispatch: wrapDispatch,
      });
    }

    case "find_references": {
      return new FindReferences.FindReferencesTool(staticRequest, {
        ...context,
        myDispatch: wrapDispatch,
      });
    }

    case "diagnostics": {
      return new Diagnostics.DiagnosticsTool(staticRequest, {
        ...context,
        myDispatch: wrapDispatch,
      });
    }

    case "bash_command": {
      return new BashCommand.BashCommandTool(staticRequest, {
        ...context,
        myDispatch: wrapDispatch,
        rememberedCommands: context.chat.rememberedCommands,
      });
    }

    case "thread_title": {
      return new ThreadTitle.ThreadTitleTool(staticRequest, {
        nvim: context.nvim,
        myDispatch: wrapDispatch,
      });
    }

    case "spawn_subagent": {
      return new SpawnSubagent.SpawnSubagentTool(staticRequest, {
        nvim: context.nvim,
        dispatch: context.dispatch,
        chat: context.chat,
        threadId: context.threadId,
        myDispatch: wrapDispatch,
      });
    }

    case "spawn_foreach": {
      return new SpawnForeach.SpawnForeachTool(staticRequest, {
        nvim: context.nvim,
        chat: context.chat,
        dispatch: context.dispatch,
        threadId: context.threadId,
        myDispatch: wrapDispatch,
        maxConcurrentSubagents: context.options.maxConcurrentSubagents || 3,
      });
    }

    case "wait_for_subagents": {
      return new WaitForSubagents.WaitForSubagentsTool(staticRequest, {
        nvim: context.nvim,
        dispatch: context.dispatch,
        threadId: context.threadId,
        chat: context.chat,
        myDispatch: wrapDispatch,
      });
    }

    case "yield_to_parent": {
      return new YieldToParent.YieldToParentTool(staticRequest, {
        nvim: context.nvim,
        dispatch: context.dispatch,
        threadId: context.threadId,
        myDispatch: wrapDispatch,
      });
    }

    case "edl": {
      return new Edl.EdlTool(staticRequest, {
        nvim: context.nvim,
        cwd: context.cwd,
        homeDir: context.homeDir,
        options: context.options,
        myDispatch: wrapDispatch,
        bufferTracker: context.bufferTracker,
        threadDispatch: context.threadDispatch,
        edlRegisters: context.edlRegisters,
      });
    }

    default:
      return assertUnreachable(staticRequest);
  }
}
