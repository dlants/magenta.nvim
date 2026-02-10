import type { ProviderName } from "./agent/provider-types.ts";

export type Profile = {
  name: string;
  provider: ProviderName;
  model: string;
  fastModel: string;
  baseUrl?: string;
  apiKeyEnvVar?: string;
  authType?: "key" | "max";
  promptCaching?: boolean;
  env?: Record<string, string>;
  thinking?:
    | {
        enabled: boolean;
        budgetTokens?: number;
      }
    | undefined;
  reasoning?:
    | {
        effort?: "low" | "medium" | "high";
        summary?: "auto" | "concise" | "detailed";
      }
    | undefined;
};

export type ServerName = string & { __serverName: true };

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
      tools?: {
        name: string;
        description: string;
        inputSchema: { [param: string]: string };
      }[];
    };

export type FilePermission = {
  path: string;
  read?: true;
  write?: true;
  readSecret?: true;
  writeSecret?: true;
};

export type SidebarPositions =
  | "left"
  | "right"
  | "below"
  | "above"
  | "tab"
  | "leftbelow"
  | "leftabove"
  | "rightbelow"
  | "rightabove";

export type CustomCommand = {
  name: string;
  text: string;
  description?: string;
};

export type HSplitWindowDimensions = {
  displayHeightPercentage: number;
  inputHeightPercentage: number;
};

export type VSplitWindowDimensions = {
  widthPercentage: number;
  displayHeightPercentage: number;
};

export type TabWindowDimensions = {
  displayHeightPercentage: number;
};

export type SidebarPositionOpts = {
  left: VSplitWindowDimensions;
  right: VSplitWindowDimensions;
  below: HSplitWindowDimensions;
  above: HSplitWindowDimensions;
  tab: TabWindowDimensions;
};

export type CommandPermissions = Record<string, unknown>;

export type MagentaOptions = {
  profiles: Profile[];
  activeProfile: string;
  sidebarPosition: SidebarPositions;
  sidebarPositionOpts: SidebarPositionOpts;
  commandConfig: CommandPermissions;
  autoContext: string[];
  skillsPaths: string[];
  maxConcurrentSubagents: number;
  mcpServers: { [serverName: ServerName]: MCPServerConfig };
  getFileAutoAllowGlobs: string[];
  filePermissions: FilePermission[];
  customCommands: CustomCommand[];
  lspDebounceMs?: number;
  debug?: boolean;
  chimeVolume?: number;
};
