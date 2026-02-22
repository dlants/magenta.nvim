import type { MagentaOptions } from "../../options.ts";
import type { Nvim } from "../../nvim/nvim-node";
import type { ProviderToolSpec } from "../../providers/provider-types.ts";
import { MCPClient } from "./client.ts";

import type { ToolName } from "../types.ts";
import { type ServerName } from "./types.ts";

type ServerMap = {
  [serverName: ServerName]: {
    client: MCPClient;
    specs: {
      [toolName: ToolName]: ProviderToolSpec;
    };
  };
};

export class MCPToolManager {
  serverMap: ServerMap;

  constructor(
    options: MagentaOptions["mcpServers"],
    private context: { nvim: Nvim },
  ) {
    this.serverMap = {};
    this.init(options, context).catch((error) => {
      this.context.nvim.logger.error(
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
        context.nvim.logger.error(
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

  async disconnect(): Promise<void> {
    // Disconnect all MCP clients
    for (const { client } of Object.values(this.serverMap)) {
      try {
        await client.disconnect();
      } catch (error) {
        // Log but don't throw - we want to try to disconnect all clients
        this.context.nvim.logger.error(
          `Error disconnecting MCP client:`,
          error,
        );
      }
    }
    this.serverMap = {};
  }
}
export function isMCPTool(toolName: string): boolean {
  return toolName.startsWith("mcp_");
}
