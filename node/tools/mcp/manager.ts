import type { MagentaOptions } from "../../options.ts";
import type { Nvim } from "../../nvim/nvim-node";
import type { ProviderToolSpec } from "../../providers/provider-types.ts";
import { MCPClient } from "./client.ts";
import { MCPTool, type Input as MCPInput, type Msg } from "./tool.ts";
import type {
  ToolManagerToolMsg,
  ToolName,
  ToolRequest,
  ToolRequestId,
} from "../types.ts";
import { parseToolName, wrapMcpToolMsg, type ServerName } from "./types.ts";

type ServerMap = {
  [serverName: ServerName]: {
    client: MCPClient;
    specs: {
      [toolName: ToolName]: ProviderToolSpec;
    };
  };
};

export class MCPToolManager {
  private tools: Map<ToolRequestId, MCPTool> = new Map();
  private serverMap: ServerMap;

  constructor(
    options: MagentaOptions["mcpServers"],
    private context: { nvim: Nvim },
  ) {
    this.serverMap = {};
    this.init(options, context).catch((error) => {
      this.context.nvim.logger?.error(
        `Failed to initialize MCPToolManager: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private async init(
    mcpServers: MagentaOptions["mcpServers"],
    context: {
      nvim: Nvim;
    },
  ) {
    for (const [serverName, config] of Object.entries(mcpServers)) {
      try {
        const client = new MCPClient(serverName as ServerName, config, {
          nvim: context.nvim,
        });
        await client.connect();
        const serverToolSpecs = client.listTools();
        this.serverMap[serverName as ServerName] = {
          client,
          specs: {},
        };
        for (const spec of serverToolSpecs) {
          this.serverMap[serverName as ServerName].specs[spec.name] = spec;
        }
      } catch (error) {
        context.nvim.logger?.error(
          `Failed to connect to MCP server ${serverName}: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Continue with other servers even if one fails
      }
    }
  }

  getToolSpecs(): ProviderToolSpec[] {
    const allToolSpecs = [];
    for (const server of Object.values(this.serverMap)) {
      allToolSpecs.push(...Object.values(server.specs));
    }
    return allToolSpecs;
  }

  isMCPTool(toolName: string): boolean {
    return toolName.startsWith("mcp.");
  }

  initMCPTool(
    request: ToolRequest,
    toolManagerDispatch: (msg: ToolManagerToolMsg) => void,
    context: { nvim: Nvim },
  ) {
    const { serverName } = parseToolName(request.toolName);

    const mcpClient = this.serverMap[serverName].client;
    if (!mcpClient) {
      toolManagerDispatch({
        type: "tool-msg",
        msg: {
          id: request.id,
          toolName: request.toolName,
          msg: wrapMcpToolMsg({
            type: "error",
            error: `${request.toolName} not found in any connected server`,
          }),
        },
      });
      return;
    }

    const mcpTool = new MCPTool(
      {
        id: request.id,
        toolName: request.toolName,
        input: request.input as MCPInput,
      },
      {
        nvim: context.nvim,
        mcpClient,
        myDispatch: (msg) =>
          toolManagerDispatch({
            type: "tool-msg",
            msg: {
              id: request.id,
              toolName: request.toolName,
              msg: wrapMcpToolMsg(msg),
            },
          }),
      },
    );

    this.tools.set(request.id, mcpTool);
  }

  getTool(id: ToolRequestId): MCPTool | undefined {
    return this.tools.get(id);
  }

  updateTool(id: ToolRequestId, msg: Msg): void {
    const tool = this.tools.get(id);
    if (tool) {
      tool.update(msg);
    }
  }

  renderToolResult(id: ToolRequestId): string {
    const tool = this.tools.get(id);
    if (!tool) {
      return "";
    }

    const result = tool.getToolResult();
    if (result.result.status === "error") {
      return `\nError: ${result.result.error}`;
    } else {
      return `\nResult:\n${JSON.stringify(result.result.value, null, 2)}\n`;
    }
  }

  async disconnect(): Promise<void> {
    // Disconnect all MCP clients
    for (const { client } of Object.values(this.serverMap)) {
      try {
        await client.disconnect();
      } catch (error) {
        // Log but don't throw - we want to try to disconnect all clients
        this.context.nvim.logger?.error(
          `Error disconnecting MCP client:`,
          error,
        );
      }
    }
    this.serverMap = {};
    this.tools.clear();
  }
}
