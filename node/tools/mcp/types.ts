import type { ToolName } from "../types.ts";

/** The tool name wihtout the mcp_serverName prefix
 */
export type MCPToolName = string & { __MCPToolName: true };
export type MCPToolRequestParams = {} & { __MCPTooRequestParams: true };
export type ServerName = string & { __ServerName: true };

export function validateServerName(name: string): ServerName {
  if (!/^[a-zA-Z0-9-]+$/.test(name)) {
    throw new Error(
      `Invalid server name "${name}". Server names must only contain alphanumeric characters and hyphens.`,
    );
  }
  return name as ServerName;
}

export function mcpToolNameToToolName(opts: {
  mcpToolName: MCPToolName;
  serverName: ServerName;
}) {
  return `mcp_${opts.serverName}_${opts.mcpToolName}` as ToolName;
}

export function parseToolName(toolName: ToolName) {
  if (!toolName.startsWith("mcp_")) {
    throw new Error(`Tool name ${toolName} is not an MCP tool`);
  }
  const parts = toolName.split("_");
  if (parts.length < 3) {
    throw new Error(`Tool name ${toolName} is not a valid MCP tool name`);
  }
  const serverName = parts[1] as ServerName;
  const mcpToolName = parts.slice(2).join("_") as MCPToolName;
  return { serverName, mcpToolName };
}
