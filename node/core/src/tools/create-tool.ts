import type { AgentsMap } from "../agents/agents.ts";
import type {
  ContextTracker,
  OnToolApplied,
} from "../capabilities/context-tracker.ts";
import type { FileIO } from "../capabilities/file-io.ts";
import type { HelpTagsProvider } from "../capabilities/help-tags-provider.ts";
import type { LspClient } from "../capabilities/lsp-client.ts";
import type { LuaExecutor } from "../capabilities/lua-executor.ts";
import type { ScriptRunner } from "../capabilities/script-runner.ts";
import type { Shell } from "../capabilities/shell.ts";
import type { ThreadManager } from "../capabilities/thread-manager.ts";
import type { ThreadId } from "../chat-types.ts";
import type { EdlRegisters } from "../edl/index.ts";
import type { Logger } from "../logger.ts";
import type { ToolInvocation, ToolRequest } from "../tool-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import * as BashCommand from "./bashCommand.ts";
import * as Docs from "./docs.ts";
import * as Edl from "./edl.ts";
import * as FindReferences from "./findReferences.ts";
import * as GetFile from "./getFile.ts";
import * as Hover from "./hover.ts";
import type { MCPToolManager } from "./mcp/manager.ts";
import * as MCPTool from "./mcp/tool.ts";
import { parseToolName } from "./mcp/types.ts";
import * as NvimLua from "./nvimLua.ts";
import * as RunScript from "./run-script.ts";
import * as Scratchpad from "./scratchpad.ts";
import * as SpawnSubagents from "./spawn-subagents.ts";
import * as ThreadTitle from "./thread-title.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import * as YieldToParent from "./yield-to-parent.ts";

export type CreateToolContext = {
  threadId: ThreadId;
  logger: Logger;
  lspClient: LspClient;
  luaExecutor?: LuaExecutor | undefined;
  mcpToolManager: MCPToolManager;
  cwd: NvimCwd;
  homeDir: HomeDir;
  maxConcurrentSubagents: number;
  maxConcurrentFastSubagents: number;
  contextTracker: ContextTracker;
  onToolApplied: OnToolApplied;
  helpTagsProvider: HelpTagsProvider;
  edlRegisters: EdlRegisters;
  scratchpad: Scratchpad.Scratchpad;
  fileIO: FileIO;
  shell: Shell;
  threadManager: ThreadManager;
  scriptRunner?: ScriptRunner | undefined;
  requestRender: () => void;
  getAgents: () => AgentsMap;
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
    case "get_files": {
      return GetFile.execute(staticRequest, {
        cwd: context.cwd,
        homeDir: context.homeDir,
        fileIO: context.fileIO,
        contextTracker: context.contextTracker,
        onToolApplied: context.onToolApplied,
      });
    }

    case "hover": {
      return Hover.execute(staticRequest, {
        cwd: context.cwd,
        homeDir: context.homeDir,
        lspClient: context.lspClient,
        fileIO: context.fileIO,
      });
    }

    case "find_references": {
      return FindReferences.execute(staticRequest, {
        cwd: context.cwd,
        homeDir: context.homeDir,
        lspClient: context.lspClient,
        fileIO: context.fileIO,
      });
    }

    case "bash_command": {
      return BashCommand.execute(staticRequest, {
        shell: context.shell,
        requestRender: context.requestRender,
      });
    }

    case "thread_title": {
      return ThreadTitle.execute(staticRequest, {});
    }

    case "spawn_subagents": {
      return SpawnSubagents.execute(staticRequest, {
        threadManager: context.threadManager,
        threadId: context.threadId,
        maxConcurrentSubagents: context.maxConcurrentSubagents,
        maxConcurrentFastSubagents: context.maxConcurrentFastSubagents,
        requestRender: context.requestRender,
        cwd: context.cwd,
        agents: context.getAgents(),
      });
    }

    case "yield_to_parent": {
      return YieldToParent.execute(staticRequest);
    }

    case "run_script": {
      return RunScript.execute(staticRequest, {
        scriptRunner: context.scriptRunner,
        threadId: context.threadId,
      });
    }

    case "edl": {
      return Edl.execute(staticRequest, {
        cwd: context.cwd,
        homeDir: context.homeDir,
        fileIO: context.fileIO,
        edlRegisters: context.edlRegisters,
        onToolApplied: context.onToolApplied,
      });
    }

    case "nvim_lua": {
      if (!context.luaExecutor) {
        throw new Error("nvim_lua tool requires a luaExecutor capability");
      }
      return NvimLua.execute(staticRequest, {
        luaExecutor: context.luaExecutor,
      });
    }

    case "scratchpad": {
      return Scratchpad.execute(staticRequest, {
        scratchpad: context.scratchpad,
      });
    }

    case "docs": {
      return Docs.execute(staticRequest, {
        fileIO: context.fileIO,
        helpTagsProvider: context.helpTagsProvider,
      });
    }

    default:
      return assertUnreachable(staticRequest);
  }
}
