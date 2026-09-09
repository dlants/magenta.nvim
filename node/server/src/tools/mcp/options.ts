import type { ServerName } from "./types.ts";

export type MCPMockToolSchemaType = "string" | "number" | "boolean";

export type MCPMockToolConfig = {
  name: string;
  description: string;
  inputSchema: { [param: string]: MCPMockToolSchemaType };
};

export type MCPServerConfig =
  | {
      type: "command";
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  | {
      type: "remote";
      url: string;
      requestInit?: RequestInit;
      sessionId?: string;
    }
  | {
      type: "mock";
      tools?: MCPMockToolConfig[];
    };

export type MCPServersConfig = { [serverName: ServerName]: MCPServerConfig };
