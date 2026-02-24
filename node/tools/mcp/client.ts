import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";
import {
  CallToolResultSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { MCPServerConfig } from "../../options.ts";
import type { Nvim } from "../../nvim/nvim-node/index.ts";
import type {
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../../providers/provider.ts";
import { assertUnreachable } from "../../utils/assertUnreachable.ts";
import type { JSONSchemaType } from "openai/lib/jsonschema.mjs";
import {
  mcpToolNameToToolName,
  type MCPToolName,
  type MCPToolRequestParams,
  type ServerName,
} from "./types.ts";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { MockMCPServer } from "./mock-server.ts";

export class MCPClient {
  private client: Client | undefined;
  private transport: Transport | undefined;
  private isConnected: boolean = false;
  private tools: Tool[] = [];

  constructor(
    public serverName: ServerName,
    private config: MCPServerConfig,
    private context: {
      nvim: Nvim;
    },
  ) {}

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }

    this.client = new Client({
      name: `magenta-mcp-client-${this.serverName}`,
      version: "1.0.0",
    });

    switch (this.config.type) {
      case "mock": {
        const mockServer = new MockMCPServer(
          this.serverName,
          this.config.tools || [],
        );
        this.transport = await mockServer.start();
        break;
      }
      case "remote": {
        const options: StreamableHTTPClientTransportOptions = {};
        if (this.config.requestInit !== undefined) {
          options.requestInit = this.config.requestInit;
        }
        if (this.config.sessionId !== undefined) {
          options.sessionId = this.config.sessionId;
        }
        this.transport = new StreamableHTTPClientTransport(
          new URL(this.config.url),
          options,
        ) as Transport;

        try {
          await this.client.connect(this.transport);
          await this.loadTools();
          this.isConnected = true;
          return;
        } catch (error) {
          // For remote servers, always try SSE transport as fallback
          this.context.nvim.logger.warn(
            `Streamable HTTP connection failed for ${this.serverName}, falling back to SSE transport: ${error instanceof Error ? error.message : String(error)}`,
          );

          try {
            // Clean up the failed transport
            if (this.transport) {
              await this.transport.close();
            }

            // Create SSE transport with same URL
            const sseOptions: SSEClientTransportOptions = {};
            if (this.config.requestInit !== undefined) {
              sseOptions.requestInit = this.config.requestInit;
            }

            this.transport = new SSEClientTransport(
              new URL(this.config.url),
              sseOptions,
            ) as Transport;

            // Try connecting with SSE transport
            await this.client.connect(this.transport);
            await this.loadTools();

            this.isConnected = true;
            return;
          } catch (sseError) {
            this.disconnect().catch((e) =>
              this.context.nvim.logger.error(
                `Error disconnecting MCP client after SSE fallback: ${e instanceof Error ? e.message : String(e)}`,
              ),
            );
            throw new Error(
              `Failed to connect to MCP server ${this.serverName} with both streamable-http and SSE transports. Streamable HTTP error: ${error instanceof Error ? error.message : String(error)}. SSE error: ${sseError instanceof Error ? sseError.message : String(sseError)}`,
            );
          }
        }
      }
      case "command": {
        for (const [key, value] of Object.entries(this.config.env || {})) {
          env[key] = value;
        }
        this.transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args,
          env,
        });
        break;
      }
      default:
        assertUnreachable(this.config);
    }

    try {
      await this.client.connect(this.transport);
      await this.loadTools();
      this.isConnected = true;
    } catch (error) {
      this.disconnect().catch((e) =>
        this.context.nvim.logger.error(
          `Error disconnecting MCP client: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
      throw new Error(
        `Failed to connect to MCP server ${this.serverName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;

    if (this.client) {
      try {
        await this.client.close();
      } catch (error) {
        this.context.nvim.logger.error(
          `Error closing MCP client ${this.serverName}:`,
          error,
        );
      }
      this.client = undefined;
    }

    if (this.transport) {
      try {
        await this.transport.close();
      } catch (error) {
        this.context.nvim.logger.error(
          `Error closing MCP transport ${this.serverName}:`,
          error,
        );
      }
      this.transport = undefined;
    }

    this.tools = [];
  }

  private async loadTools(): Promise<void> {
    if (!this.client) {
      throw new Error(`Client not connected for MCP server ${this.serverName}`);
    }

    try {
      const response = await this.client.listTools();
      this.tools = response.tools;
    } catch (error) {
      throw new Error(
        `Failed to load tools from MCP server ${this.serverName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  listTools(): ProviderToolSpec[] {
    return this.tools.map((tool) => ({
      name: mcpToolNameToToolName({
        serverName: this.serverName,
        mcpToolName: tool.name as MCPToolName,
      }),
      description: tool.description ?? "",
      input_schema: tool.inputSchema as JSONSchemaType,
    }));
  }

  async callTool(
    toolName: MCPToolName,
    params: MCPToolRequestParams,
  ): Promise<ProviderToolResultContent[]> {
    if (!this.client || !this.isConnected) {
      throw new Error(`MCP client ${this.serverName} is not connected`);
    }

    const result: CallToolResult = await this.client.request(
      {
        method: "tools/call",
        params: {
          name: toolName,
          arguments: params,
        },
      },
      CallToolResultSchema,
    );

    const content = result.content.map((c): ProviderToolResultContent => {
      switch (c.type) {
        case "text":
          return {
            type: "text",
            text: c.text,
          };
        case "image":
          return {
            type: "image",
            source: {
              type: "base64",
              media_type: c.mimeType as
                | "image/jpeg"
                | "image/png"
                | "image/gif"
                | "image/webp",
              data: c.data,
            },
          };
        case "audio":
          return {
            type: "text",
            text: `[MCP audio content type not supported yet]`,
          };
        case "resource_link":
          return {
            type: "text",
            text: `[MCP resource_link content type not supported yet]`,
          };
        case "resource":
          return {
            type: "text",
            text: `[MCP resource content type not supported yet]`,
          };
        default:
          assertUnreachable(c);
      }
    });

    if (result.isError) {
      const textContent = content
        .filter((c) => c.type == "text")
        .map((c) => c.text)
        .join("\n");

      throw new Error(textContent);
    } else {
      return content;
    }
  }

  isToolAvailable(toolName: string): boolean {
    const expectedPrefix = `mcp_${this.serverName}.`;
    if (!toolName.startsWith(expectedPrefix)) {
      return false;
    }

    const actualToolName = toolName.slice(expectedPrefix.length);
    return this.tools.some((tool) => tool.name === actualToolName);
  }

  getConnectionStatus(): {
    connected: boolean;
    serverName: string;
    toolCount: number;
  } {
    return {
      connected: this.isConnected,
      serverName: this.serverName,
      toolCount: this.tools.length,
    };
  }
}
