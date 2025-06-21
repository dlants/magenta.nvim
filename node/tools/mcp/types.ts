import type { ToolMsg, ToolName } from "../types";
import type { Msg } from "./tool";

/** The tool name wihtout the mcp.serverName prefix
 */
export type MCPToolName = string & { __MCPToolName: true };
export type MCPToolRequestParams = {} & { __MCPTooRequestParams: true };
export type ServerName = string & { __ServerName: true };

export function mcpToolNameToToolName(opts: {
  mcpToolName: MCPToolName;
  serverName: ServerName;
}) {
  return `mcp.${opts.serverName}.${opts.mcpToolName}` as ToolName;
}

export function wrapMcpToolMsg(msg: Msg): ToolMsg {
  return msg as unknown as ToolMsg;
}

export function unwrapMcpToolMsg(msg: ToolMsg): Msg {
  return msg as unknown as Msg;
}

export function parseToolName(toolName: ToolName) {
  if (!toolName.startsWith("mcp.")) {
    throw new Error(`Tool name ${toolName} is not an MCP tool`);
  }
  const parts = toolName.split(".");
  if (parts.length < 3) {
    throw new Error(`Tool name ${toolName} is not a valid MCP tool name`);
  }
  const serverName = parts[1] as ServerName;
  const mcpToolName = parts.slice(2).join(".") as MCPToolName;
  return { serverName, mcpToolName };
}
