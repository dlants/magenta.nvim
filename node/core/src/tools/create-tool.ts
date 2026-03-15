import type {
  ContextTracker,
  OnToolApplied,
} from "../capabilities/context-tracker.ts";
import type { DiagnosticsProvider } from "../capabilities/diagnostics-provider.ts";
import type { FileIO } from "../capabilities/file-io.ts";
import type { LspClient } from "../capabilities/lsp-client.ts";
import type { Shell } from "../capabilities/shell.ts";
import type { ThreadManager } from "../capabilities/thread-manager.ts";
import type { ThreadId } from "../chat-types.ts";
import type { ContainerConfig, ProvisionResult } from "../container/types.ts";
import type { EdlRegisters } from "../edl/index.ts";
import type { Logger } from "../logger.ts";
import type { ToolSkillConfig } from "../provider-options.ts";
import type { ToolInvocation, ToolRequest } from "../tool-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import * as BashCommand from "./bashCommand.ts";
import * as Diagnostics from "./diagnostics.ts";
import * as Edl from "./edl.ts";
import * as FindReferences from "./findReferences.ts";
import * as GetFile from "./getFile.ts";
import * as Hover from "./hover.ts";
import type { MCPToolManager } from "./mcp/manager.ts";
import * as MCPTool from "./mcp/tool.ts";
import { parseToolName } from "./mcp/types.ts";
import * as SpawnForeach from "./spawn-foreach.ts";
import * as SpawnSubagent from "./spawn-subagent.ts";
import * as ThreadTitle from "./thread-title.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import * as UseSkill from "./useSkill.ts";
import * as WaitForSubagents from "./wait-for-subagents.ts";
import * as YieldToParent from "./yield-to-parent.ts";

export type CreateToolContext = {
  threadId: ThreadId;
  logger: Logger;
  lspClient: LspClient;
  mcpToolManager: MCPToolManager;
  cwd: NvimCwd;
  homeDir: HomeDir;
  maxConcurrentSubagents: number;
  contextTracker: ContextTracker;
  onToolApplied: OnToolApplied;
  diagnosticsProvider: DiagnosticsProvider;
  edlRegisters: EdlRegisters;
  fileIO: FileIO;
  shell: Shell;
  threadManager: ThreadManager;
  requestRender: () => void;
  toolSkills: ToolSkillConfig[];
  containerProvisioner?:
    | {
        containerConfig: ContainerConfig;
        provision: (opts: {
          repoPath: string;
          baseBranch?: string;
          containerConfig: ContainerConfig;
          onProgress?: (message: string) => void;
        }) => Promise<ProvisionResult>;
      }
    | undefined;
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

    case "diagnostics": {
      return Diagnostics.execute(staticRequest, {
        diagnosticsProvider: context.diagnosticsProvider,
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

    case "spawn_subagent": {
      return SpawnSubagent.execute(staticRequest, {
        threadManager: context.threadManager,
        threadId: context.threadId,
        requestRender: context.requestRender,
        cwd: context.cwd,
        containerProvisioner: context.containerProvisioner,
      });
    }

    case "spawn_foreach": {
      return SpawnForeach.execute(staticRequest, {
        threadManager: context.threadManager,
        threadId: context.threadId,
        maxConcurrentSubagents: context.maxConcurrentSubagents,
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
        cwd: context.cwd,
        homeDir: context.homeDir,
        fileIO: context.fileIO,
        edlRegisters: context.edlRegisters,
        onToolApplied: context.onToolApplied,
      });
    }

    case "use_skill": {
      return UseSkill.execute(staticRequest, {
        toolSkills: context.toolSkills,
        requestRender: context.requestRender,
      });
    }

    default:
      return assertUnreachable(staticRequest);
  }
}
