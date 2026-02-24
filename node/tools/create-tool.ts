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

import type { EdlRegisters } from "@magenta/core";

import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { Lsp } from "../capabilities/lsp.ts";
import type { MagentaOptions } from "../options.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import type { ToolRequest, ToolInvocation } from "./types.ts";
import type { ThreadId } from "../chat/types.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";

import type { ContextManager } from "../context/context-manager.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { Msg as ThreadMsg } from "../chat/thread.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import type { MCPToolManager } from "./mcp/manager.ts";
import type { FileIO } from "@magenta/core";
import type { Shell } from "../capabilities/shell.ts";
import type { ThreadManager } from "../capabilities/thread-manager.ts";
import { parseToolName } from "./mcp/types.ts";
import * as MCPTool from "./mcp/tool.ts";

export type CreateToolContext = {
  bufferTracker: BufferTracker;
  getDisplayWidth: () => number;
  threadId: ThreadId;
  nvim: Nvim;
  lsp: Lsp;
  mcpToolManager: MCPToolManager;
  cwd: NvimCwd;
  homeDir: HomeDir;
  options: MagentaOptions;
  contextManager: ContextManager;
  threadDispatch: Dispatch<ThreadMsg>;
  edlRegisters: EdlRegisters;
  fileIO: FileIO;
  shell: Shell;
  threadManager: ThreadManager;
  requestRender: () => void;
};

export function createTool(
  request: ToolRequest,
  context: CreateToolContext,
): ToolInvocation {
  if (request.toolName.startsWith("mcp_")) {
    const { serverName } = parseToolName(request.toolName);

    const mcpClient = context.mcpToolManager.serverMap[serverName].client;
    if (!mcpClient) {
      throw new Error(`${request.toolName} not found in any connected server`);
    }

    return MCPTool.execute(
      {
        id: request.id,
        toolName: request.toolName,
        input: request.input as MCPTool.Input,
      },
      {
        mcpClient,
        requestRender: context.requestRender,
      },
    );
  }

  const staticRequest = request as StaticToolRequest;

  switch (staticRequest.toolName) {
    case "get_file": {
      return GetFile.execute(staticRequest, {
        nvim: context.nvim,
        cwd: context.cwd,
        homeDir: context.homeDir,
        fileIO: context.fileIO,
        contextManager: context.contextManager,
        threadDispatch: context.threadDispatch,
      });
    }

    case "hover": {
      return Hover.execute(staticRequest, {
        nvim: context.nvim,
        cwd: context.cwd,
        homeDir: context.homeDir,
        lsp: context.lsp,
      });
    }

    case "find_references": {
      return FindReferences.execute(staticRequest, {
        nvim: context.nvim,
        cwd: context.cwd,
        homeDir: context.homeDir,
        lsp: context.lsp,
      });
    }

    case "diagnostics": {
      return Diagnostics.execute(staticRequest, {
        nvim: context.nvim,
        cwd: context.cwd,
        homeDir: context.homeDir,
      });
    }

    case "bash_command": {
      return BashCommand.execute(staticRequest, {
        shell: context.shell,
        requestRender: context.requestRender,
        options: context.options,
      });
    }

    case "thread_title": {
      return ThreadTitle.execute(staticRequest, {
        nvim: context.nvim,
      });
    }

    case "spawn_subagent": {
      return SpawnSubagent.execute(staticRequest, {
        threadManager: context.threadManager,
        threadId: context.threadId,
        requestRender: context.requestRender,
      });
    }

    case "spawn_foreach": {
      return SpawnForeach.execute(staticRequest, {
        threadManager: context.threadManager,
        threadId: context.threadId,
        maxConcurrentSubagents: context.options.maxConcurrentSubagents || 3,
        requestRender: context.requestRender,
      });
    }

    case "wait_for_subagents": {
      return WaitForSubagents.execute(staticRequest, {
        threadManager: context.threadManager,
        requestRender: context.requestRender,
      });
    }

    case "yield_to_parent": {
      return YieldToParent.execute(staticRequest);
    }

    case "edl": {
      return Edl.execute(staticRequest, {
        nvim: context.nvim,
        cwd: context.cwd,
        homeDir: context.homeDir,
        fileIO: context.fileIO,
        bufferTracker: context.bufferTracker,
        threadDispatch: context.threadDispatch,
        edlRegisters: context.edlRegisters,
      });
    }

    default:
      return assertUnreachable(staticRequest);
  }
}
