import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type ServerName, validateServerName } from "@magenta/core";
import { PROVIDER_NAMES, type ProviderName } from "./providers/provider.ts";
import type { NvimCwd } from "./utils/files.ts";

// Get the path to the built-in agents directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const BUILTIN_AGENTS_PATH = path.join(
  __dirname,
  "core",
  "src",
  "agents",
);

// The plugin's own skills directory, shipped at the repo/install root.
export const BUILTIN_SKILLS_PATH = path.join(__dirname, "..", "skills");

// The bundled SDK directory, shipped at the repo/install root. Defined here
// (a depth-1 module) with a single `..` so it resolves to `<root>/sdk` both
// from source (`node/options.ts`) and from the bundle (`dist/magenta.mjs`).
export const BUILTIN_SDK_PATH = path.join(__dirname, "..", "sdk");

// Default models by provider
const DEFAULT_MODELS: Record<
  ProviderName,
  { model: string; fastModel?: string; thinkingModel?: string }
> = {
  anthropic: {
    model: "claude-sonnet-5",
    fastModel: "claude-haiku-4-5",
    thinkingModel: "claude-opus-4-8",
  },
  openai: {
    model: "gpt-4.1",
    fastModel: "gpt-4o-mini",
  },
  bedrock: {
    model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    fastModel: "anthropic.claude-3-5-haiku-20241022-v1:0",
  },
  ollama: {
    model: "llama3.1:8b",
  },
  copilot: {
    model: "claude-sonnet-5",
    fastModel: "claude-haiku-4-5",
    thinkingModel: "claude-opus-4-8",
  },
  mock: {
    model: "mock",
    fastModel: "mock-fast",
  },
};

export type Profile = {
  name: string;
  provider: ProviderName;
  model: string;
  fastModel: string;
  thinkingModel: string;
  baseUrl?: string;
  apiKeyEnvVar?: string;
  authType?: "key" | "max" | "keychain"; // New field for authentication type
  promptCaching?: boolean; // Primarily used by Bedrock provider
  env?: Record<string, string>; // Environment variables to set before provider initialization (e.g., AWS_PROFILE, AWS_REGION)
  tokenRefreshCommand?: string; // Shell command to run when an auth error occurs (e.g., "aws sso login --profile myprofile"); currently Bedrock-only
  thinking?:
    | {
        enabled: boolean;
        budgetTokens?: number;
        displayThinking?: boolean;
        effort?: "low" | "medium" | "high" | "xhigh" | "max";
      }
    | undefined;
  reasoning?:
    | {
        effort?: "low" | "medium" | "high" | "xhigh";
        summary?: "auto" | "concise" | "detailed";
      }
    | undefined;
};

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

export type CustomCommand = {
  name: string;
  text: string;
  description?: string;
  systemReminder?: string;
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
export type SidebarPositionOpts = {
  left: VSplitWindowDimensions;
  right: VSplitWindowDimensions;
  below: HSplitWindowDimensions;
  above: HSplitWindowDimensions;
  tab: TabWindowDimensions;
};

export type OnUnknownHostBehavior = "prompt" | "allow" | "deny";

export type SandboxConfig = {
  filesystem: {
    allowWrite: string[];
    denyWrite: string[];
    denyRead: string[];
    allowRead: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowUnixSockets: string[];
    allowAllUnixSockets: boolean;
    onUnknownHost: OnUnknownHostBehavior;
  };
  requireApprovalPatterns: string[];
  strace: {
    autoAllowViolations: boolean;
  };
};

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  filesystem: {
    allowWrite: ["./"],
    denyWrite: [".env", ".git/hooks/", ".magenta", "~/.magenta"],
    denyRead: [
      // Credentials and keys (literal paths → subpath matching blocks dir + all contents)
      "~/.ssh",
      "~/.gnupg",
      "~/.aws",
      "~/.azure",
      "~/.config/gcloud",
      "~/.docker",
      "~/.kube",
      "~/.password-store",
      "~/.netrc",
      "~/.npmrc",
      "~/.pypirc",
      "~/.gem",
      "~/.config/gh",
      // Shell configs (can execute code on shell startup)
      "~/.bashrc",
      "~/.bash_profile",
      "~/.bash_login",
      "~/.bash_logout",
      "~/.zshrc",
      "~/.zprofile",
      "~/.zshenv",
      "~/.zlogin",
      "~/.zlogout",
      "~/.profile",
      "~/.config/fish",
    ],
    allowRead: [],
  },
  network: {
    allowedDomains: [
      "registry.npmjs.org",
      "github.com",
      "*.github.com",
      "pypi.org",
      "files.pythonhosted.org",
      "rubygems.org",
      "crates.io",
    ],
    deniedDomains: [],
    allowUnixSockets: [],
    allowAllUnixSockets: false,
    onUnknownHost: "prompt",
  },
  requireApprovalPatterns: ["git\\s+push"],
  strace: {
    autoAllowViolations: false,
  },
};

export type MagentaOptions = {
  profiles: Profile[];
  activeProfile: string;
  sidebarPosition: SidebarPositions;
  sidebarPositionOpts: SidebarPositionOpts;
  sandbox: SandboxConfig;
  autoContext: string[];
  hierarchyContextFileNames: string[];
  skillsPaths: string[];
  scriptsPaths: string[];
  suppressProjectSkills: string[];
  agentsPaths: string[];
  maxConcurrentSubagents: number;
  maxConcurrentFastSubagents: number;
  autoCompactThreshold: number;
  autoCompactPrompt?: string;
  mcpServers: { [serverName: ServerName]: MCPServerConfig };
  customCommands: CustomCommand[];
  lspDebounceMs?: number;
  debug?: boolean;
  chimeVolume?: number;
  bellOnNotify?: boolean;
};

// Reusable parsing helpers
function parseProfiles(
  profilesInput: unknown,
  logger: { warn: (msg: string) => void },
): Profile[] {
  if (!Array.isArray(profilesInput)) {
    logger.warn("profiles must be an array");
    return [];
  }

  const profiles: Profile[] = [];

  for (const profile of profilesInput) {
    try {
      if (typeof profile !== "object" || profile === null) {
        logger.warn(`Skipping invalid profile: ${JSON.stringify(profile)}`);
        continue;
      }

      const p = profile as { [key: string]: unknown };

      if (
        !(
          typeof p.name === "string" &&
          typeof p.provider === "string" &&
          PROVIDER_NAMES.indexOf(p.provider as ProviderName) !== -1
        )
      ) {
        logger.warn(
          `Skipping profile with missing required fields: ${JSON.stringify(p)}`,
        );
        continue;
      }

      const provider = p.provider as ProviderName;
      const defaults = DEFAULT_MODELS[provider];

      const model = typeof p.model === "string" ? p.model : defaults.model;

      const out: Profile = {
        name: p.name,
        provider,
        model,
        fastModel:
          typeof p.fastModel === "string"
            ? p.fastModel
            : (defaults.fastModel ?? model),
        thinkingModel:
          typeof p.thinkingModel === "string"
            ? p.thinkingModel
            : (defaults.thinkingModel ?? model),
      };

      if ("baseUrl" in p) {
        if (typeof p.baseUrl === "string") {
          out.baseUrl = p.baseUrl;
        } else {
          logger.warn(`Invalid baseUrl in profile ${p.name}, ignoring field`);
        }
      }

      if ("apiKeyEnvVar" in p) {
        if (typeof p.apiKeyEnvVar === "string") {
          out.apiKeyEnvVar = p.apiKeyEnvVar;
        } else {
          logger.warn(
            `Invalid apiKeyEnvVar in profile ${p.name}, ignoring field`,
          );
        }
      }

      if ("authType" in p) {
        if (
          typeof p.authType === "string" &&
          (p.authType === "key" ||
            p.authType === "max" ||
            p.authType === "keychain")
        ) {
          out.authType = p.authType;
        } else {
          logger.warn(
            `Invalid authType in profile ${p.name}, must be "key", "max", or "keychain"`,
          );
        }
      }

      if ("promptCaching" in p) {
        if (typeof p.promptCaching === "boolean") {
          out.promptCaching = p.promptCaching;
        } else {
          logger.warn(
            `Invalid promptCaching in profile ${p.name}, ignoring field`,
          );
        }
      }

      if ("tokenRefreshCommand" in p) {
        if (
          typeof p.tokenRefreshCommand === "string" &&
          p.tokenRefreshCommand.length > 0
        ) {
          out.tokenRefreshCommand = p.tokenRefreshCommand;
        } else {
          logger.warn(
            `Invalid tokenRefreshCommand in profile ${p.name}, must be a non-empty string`,
          );
        }
      }

      if ("env" in p) {
        if (
          typeof p.env === "object" &&
          p.env !== null &&
          !Array.isArray(p.env)
        ) {
          const env: Record<string, string> = {};
          const envObj = p.env as Record<string, unknown>;

          for (const [envKey, envValue] of Object.entries(envObj)) {
            if (typeof envValue === "string") {
              env[envKey] = envValue;
            } else {
              logger.warn(
                `Skipping non-string env value in profile ${p.name}: ${envKey}=${JSON.stringify(envValue)}`,
              );
            }
          }

          if (Object.keys(env).length > 0) {
            out.env = env;
          }
        } else {
          logger.warn(`Invalid env in profile ${p.name}, must be an object`);
        }
      }

      if ("thinking" in p) {
        if (typeof p.thinking === "object" && p.thinking !== null) {
          const thinking = p.thinking as { [key: string]: unknown };
          if (typeof thinking.enabled === "boolean") {
            out.thinking = {
              enabled: thinking.enabled,
            };
            if (
              typeof thinking.budgetTokens === "number" &&
              thinking.budgetTokens >= 1024
            ) {
              out.thinking.budgetTokens = thinking.budgetTokens;
            } else if ("budgetTokens" in thinking) {
              logger.warn(
                `Invalid budgetTokens in profile ${p.name}, must be a number >= 1024`,
              );
            }
            if (typeof thinking.displayThinking === "boolean") {
              out.thinking.displayThinking = thinking.displayThinking;
            }
            if ("effort" in thinking) {
              if (
                typeof thinking.effort === "string" &&
                ["low", "medium", "high", "xhigh", "max"].includes(
                  thinking.effort,
                )
              ) {
                out.thinking.effort = thinking.effort as
                  | "low"
                  | "medium"
                  | "high"
                  | "xhigh"
                  | "max";
              } else {
                logger.warn(
                  `Invalid effort in profile ${p.name}, must be "low", "medium", "high", "xhigh", or "max"`,
                );
              }
            }
          } else {
            logger.warn(
              `Invalid thinking config in profile ${p.name}, must have enabled boolean field`,
            );
          }
        } else {
          logger.warn(
            `Invalid thinking in profile ${p.name}, must be an object`,
          );
        }
      }

      if ("reasoning" in p) {
        if (typeof p.reasoning === "object" && p.reasoning !== null) {
          const reasoning = p.reasoning as { [key: string]: unknown };
          out.reasoning = {};

          if ("effort" in reasoning) {
            if (
              typeof reasoning.effort === "string" &&
              ["low", "medium", "high", "xhigh"].includes(reasoning.effort)
            ) {
              out.reasoning.effort = reasoning.effort as
                | "low"
                | "medium"
                | "high";
            } else {
              logger.warn(
                `Invalid effort in profile ${p.name}, must be "low", "medium", "high", or "xhigh"`,
              );
            }
          }

          if ("summary" in reasoning) {
            if (
              typeof reasoning.summary === "string" &&
              ["auto", "concise", "detailed"].includes(reasoning.summary)
            ) {
              out.reasoning.summary = reasoning.summary as
                | "auto"
                | "concise"
                | "detailed";
            } else {
              logger.warn(
                `Invalid summary in profile ${p.name}, must be "auto", "concise", or "detailed"`,
              );
            }
          }
        } else {
          logger.warn(
            `Invalid reasoning in profile ${p.name}, must be an object`,
          );
        }
      }

      profiles.push(out);
    } catch (error) {
      logger.warn(
        `Error parsing profile: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return profiles;
}

function parseStringArray(
  input: unknown,
  fieldName: string,
  logger?: { warn: (msg: string) => void },
): string[] {
  if (!Array.isArray(input)) {
    logger?.warn(`${fieldName} must be an array`);
    return [];
  }

  return input.filter((item) => {
    if (typeof item === "string") {
      return true;
    } else {
      logger?.warn(
        `Skipping non-string item in ${fieldName}: ${JSON.stringify(item)}`,
      );
      return false;
    }
  }) as string[];
}

function parseMCPServers(
  input: unknown,
  logger: { warn: (msg: string) => void },
): Record<string, MCPServerConfig> {
  if (!input) {
    return {};
  }

  if (typeof input !== "object") {
    logger.warn("mcpServers must be an object");
    return {};
  }

  const servers: Record<string, MCPServerConfig> = {};
  const inputObj = input as Record<string, unknown>;

  for (const [serverName, serverConfig] of Object.entries(inputObj)) {
    try {
      // Validate server name format
      try {
        validateServerName(serverName);
      } catch (error) {
        logger.warn(
          `Skipping MCP server with invalid name "${serverName}": ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      if (typeof serverConfig !== "object" || serverConfig === null) {
        logger.warn(
          `Skipping invalid MCP server config for ${serverName}: must be an object`,
        );
        continue;
      }

      const config = serverConfig as Record<string, unknown>;

      // Auto-detect mock type by presence of tools field
      if (config.tools && Array.isArray(config.tools)) {
        const mockConfig: MCPServerConfig = {
          type: "mock",
          tools: config.tools as MCPMockToolConfig[],
        };
        servers[serverName] = mockConfig;
        continue;
      }

      // Auto-detect remote type by presence of url field
      if (config.url) {
        if (typeof config.url !== "string") {
          logger.warn(
            `Skipping MCP server ${serverName}: url must be a string for remote type`,
          );
          continue;
        }

        const remoteConfig: MCPServerConfig = {
          type: "remote",
          url: config.url,
        };

        if (config.requestInit !== undefined) {
          if (
            typeof config.requestInit === "object" &&
            config.requestInit !== null
          ) {
            remoteConfig.requestInit = config.requestInit as RequestInit;
          } else {
            logger.warn(
              `Invalid requestInit in MCP server ${serverName}: must be an object`,
            );
          }
        }

        if (config.sessionId !== undefined) {
          if (typeof config.sessionId === "string") {
            remoteConfig.sessionId = config.sessionId;
          } else {
            logger.warn(
              `Invalid sessionId in MCP server ${serverName}: must be a string`,
            );
          }
        }

        servers[serverName] = remoteConfig;
        continue;
      }

      // Auto-detect command type by presence of command field
      if (config.command) {
        if (typeof config.command !== "string") {
          logger.warn(
            `Skipping MCP server ${serverName}: command must be a string`,
          );
          continue;
        }

        if (!Array.isArray(config.args)) {
          logger.warn(
            `Skipping MCP server ${serverName}: args must be an array`,
          );
          continue;
        }

        const args = config.args.filter((arg) => {
          if (typeof arg === "string") {
            return true;
          } else {
            logger.warn(
              `Skipping non-string arg in MCP server ${serverName}: ${JSON.stringify(arg)}`,
            );
            return false;
          }
        }) as string[];

        const serverConfigOut: MCPServerConfig = {
          type: "command",
          command: config.command,
          args,
        };

        if (config.env !== undefined) {
          if (
            typeof config.env === "object" &&
            config.env !== null &&
            !Array.isArray(config.env)
          ) {
            const env: Record<string, string> = {};
            const envObj = config.env as Record<string, unknown>;

            for (const [envKey, envValue] of Object.entries(envObj)) {
              if (typeof envValue === "string") {
                env[envKey] = envValue;
              } else {
                logger.warn(
                  `Skipping non-string env value in MCP server ${serverName}: ${envKey}=${JSON.stringify(envValue)}`,
                );
              }
            }

            if (Object.keys(env).length > 0) {
              serverConfigOut.env = env;
            }
          } else {
            logger.warn(
              `Invalid env in MCP server ${serverName}: must be an object`,
            );
          }
        }

        servers[serverName] = serverConfigOut;
        continue;
      }

      logger.warn(
        `Skipping MCP server ${serverName}: missing required fields (must have either 'url' for remote, 'command' for command, or 'tools' for mock)`,
      );
    } catch (error) {
      logger.warn(
        `Error parsing MCP server ${serverName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return servers;
}

function parseCustomCommands(
  input: unknown,
  logger: { warn: (msg: string) => void },
): CustomCommand[] {
  if (!Array.isArray(input)) {
    logger.warn("customCommands must be an array");
    return [];
  }

  const customCommands: CustomCommand[] = [];

  for (const commandInput of input) {
    try {
      if (typeof commandInput !== "object" || commandInput === null) {
        logger.warn(
          `Skipping invalid custom command: ${JSON.stringify(commandInput)}`,
        );
        continue;
      }

      const command = commandInput as { [key: string]: unknown };

      if (
        typeof command.name !== "string" ||
        typeof command.text !== "string"
      ) {
        logger.warn(
          "Custom command must have 'name' and 'text' fields as strings",
        );
        continue;
      }

      const commandName = command.name;
      if (!commandName.startsWith("@")) {
        logger.warn(`Custom command name must start with @: ${commandName}`);
        continue;
      }

      if (!/^@[a-zA-Z][a-zA-Z0-9_]*$/.test(commandName)) {
        logger.warn(
          `Custom command name contains invalid characters: ${commandName}`,
        );
        continue;
      }

      const customCommand: CustomCommand = {
        name: commandName,
        text: command.text,
      };

      if (typeof command.description === "string") {
        customCommand.description = command.description;
      }

      if (command.systemReminder !== undefined) {
        if (typeof command.systemReminder === "string") {
          customCommand.systemReminder = command.systemReminder;
        } else {
          logger.warn(
            `Custom command '${commandName}' systemReminder must be a string; ignoring`,
          );
        }
      }

      customCommands.push(customCommand);
    } catch (error) {
      logger.warn(
        `Error parsing custom command: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return customCommands;
}

function parseSidebarPosition(
  input: unknown,
  logger?: { warn: (msg: string) => void },
): SidebarPositions | undefined {
  if (
    input === "right" ||
    input === "left" ||
    input === "above" ||
    input === "below" ||
    input === "tab" ||
    input === "leftbelow" ||
    input === "leftabove" ||
    input === "rightbelow" ||
    input === "rightabove"
  ) {
    return input as SidebarPositions;
  } else if (input !== undefined) {
    logger?.warn(
      `Invalid sidebarPosition: ${JSON.stringify(input)}, must be "left", "right", "above", "below", "tab", "leftbelow", "leftabove", "rightbelow", or "rightabove"`,
    );
  }
  return undefined;
}

function parseSidebarPositionOpts(
  input: unknown,
  logger?: { warn: (msg: string) => void },
): SidebarPositionOpts | undefined {
  if (typeof input !== "object" || input === null) {
    logger?.warn("sidebarPositionOpts must be an object");
    return undefined;
  }

  const opts = input as { [key: string]: unknown };
  const result: Partial<SidebarPositionOpts> = {};

  // Parse left/right (VSplitWindowDimensions)
  for (const side of ["left", "right"] as const) {
    if (side in opts) {
      const sideOpts = opts[side];
      if (typeof sideOpts === "object" && sideOpts !== null) {
        const sideOptsObj = sideOpts as { [key: string]: unknown };
        if (
          typeof sideOptsObj.widthPercentage === "number" &&
          typeof sideOptsObj.displayHeightPercentage === "number"
        ) {
          result[side] = {
            widthPercentage: sideOptsObj.widthPercentage,
            displayHeightPercentage: sideOptsObj.displayHeightPercentage,
          };
        } else {
          logger?.warn(
            `sidebarPositionOpts.${side} must have widthPercentage and displayHeightPercentage`,
          );
        }
      } else {
        logger?.warn(`sidebarPositionOpts.${side} must be an object`);
      }
    }
  }

  // Parse above/below (HSplitWindowDimensions)
  for (const side of ["above", "below"] as const) {
    if (side in opts) {
      const sideOpts = opts[side];
      if (typeof sideOpts === "object" && sideOpts !== null) {
        const sideOptsObj = sideOpts as { [key: string]: unknown };
        if (
          typeof sideOptsObj.displayHeightPercentage === "number" &&
          typeof sideOptsObj.inputHeightPercentage === "number"
        ) {
          result[side] = {
            displayHeightPercentage: sideOptsObj.displayHeightPercentage,
            inputHeightPercentage: sideOptsObj.inputHeightPercentage,
          };
        } else {
          logger?.warn(
            `sidebarPositionOpts.${side} must have displayHeightPercentage and inputHeightPercentage`,
          );
        }
      } else {
        logger?.warn(`sidebarPositionOpts.${side} must be an object`);
      }
    }
  }

  // Parse tab (TabWindowDimensions)
  if ("tab" in opts) {
    const tabOpts = opts.tab;
    if (typeof tabOpts === "object" && tabOpts !== null) {
      const tabOptsObj = tabOpts as { [key: string]: unknown };
      if (typeof tabOptsObj.displayHeightPercentage === "number") {
        result.tab = {
          displayHeightPercentage: tabOptsObj.displayHeightPercentage,
        };
      } else {
        logger?.warn(
          "sidebarPositionOpts.tab must have displayHeightPercentage",
        );
      }
    } else {
      logger?.warn("sidebarPositionOpts.tab must be an object");
    }
  }

  // Return undefined if no valid options were parsed
  if (Object.keys(result).length === 0) {
    return undefined;
  }

  return result as SidebarPositionOpts;
}

function mergeSandboxConfigs(
  base: SandboxConfig,
  overlay: SandboxConfig,
): SandboxConfig {
  return {
    filesystem: {
      allowWrite: [
        ...base.filesystem.allowWrite,
        ...overlay.filesystem.allowWrite,
      ],
      denyWrite: [
        ...base.filesystem.denyWrite,
        ...overlay.filesystem.denyWrite,
      ],
      denyRead: [...base.filesystem.denyRead, ...overlay.filesystem.denyRead],
      allowRead: [
        ...base.filesystem.allowRead,
        ...overlay.filesystem.allowRead,
      ],
    },
    network: {
      allowedDomains: [
        ...base.network.allowedDomains,
        ...overlay.network.allowedDomains,
      ],
      deniedDomains: [
        ...base.network.deniedDomains,
        ...overlay.network.deniedDomains,
      ],
      allowUnixSockets: [
        ...base.network.allowUnixSockets,
        ...overlay.network.allowUnixSockets,
      ],
      allowAllUnixSockets:
        overlay.network.allowAllUnixSockets || base.network.allowAllUnixSockets,
      onUnknownHost: overlay.network.onUnknownHost,
    },
    requireApprovalPatterns: [
      ...base.requireApprovalPatterns,
      ...overlay.requireApprovalPatterns,
    ],
    strace: {
      autoAllowViolations: overlay.strace.autoAllowViolations,
    },
  };
}

function parseSandboxConfig(
  input: unknown,
  logger: { warn: (msg: string) => void },
): SandboxConfig {
  const config: SandboxConfig = {
    filesystem: { allowWrite: [], denyWrite: [], denyRead: [], allowRead: [] },
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      onUnknownHost: "prompt",
    },
    requireApprovalPatterns: [],
    strace: {
      autoAllowViolations: false,
    },
  };

  if (typeof input !== "object" || input === null) {
    if (input !== undefined) {
      logger.warn("sandbox config must be an object");
    }
    return config;
  }

  const obj = input as Record<string, unknown>;

  if (typeof obj.filesystem === "object" && obj.filesystem !== null) {
    const fs = obj.filesystem as Record<string, unknown>;
    if (Array.isArray(fs.allowWrite)) {
      config.filesystem.allowWrite = parseStringArray(
        fs.allowWrite,
        "sandbox.filesystem.allowWrite",
        logger,
      );
    }
    if (Array.isArray(fs.denyWrite)) {
      config.filesystem.denyWrite = parseStringArray(
        fs.denyWrite,
        "sandbox.filesystem.denyWrite",
        logger,
      );
    }
    if (Array.isArray(fs.denyRead)) {
      config.filesystem.denyRead = parseStringArray(
        fs.denyRead,
        "sandbox.filesystem.denyRead",
        logger,
      );
    }
    if (Array.isArray(fs.allowRead)) {
      config.filesystem.allowRead = parseStringArray(
        fs.allowRead,
        "sandbox.filesystem.allowRead",
        logger,
      );
    }
  } else if ("filesystem" in obj) {
    logger.warn("sandbox.filesystem must be an object");
  }

  if (typeof obj.network === "object" && obj.network !== null) {
    const net = obj.network as Record<string, unknown>;
    if (Array.isArray(net.allowedDomains)) {
      config.network.allowedDomains = parseStringArray(
        net.allowedDomains,
        "sandbox.network.allowedDomains",
        logger,
      );
    }
    if (Array.isArray(net.deniedDomains)) {
      config.network.deniedDomains = parseStringArray(
        net.deniedDomains,
        "sandbox.network.deniedDomains",
        logger,
      );
    }
    if (Array.isArray(net.allowUnixSockets)) {
      config.network.allowUnixSockets = parseStringArray(
        net.allowUnixSockets,
        "sandbox.network.allowUnixSockets",
        logger,
      );
    }
    if (typeof net.allowAllUnixSockets === "boolean") {
      config.network.allowAllUnixSockets = net.allowAllUnixSockets;
    }
    if ("onUnknownHost" in net) {
      if (
        net.onUnknownHost === "prompt" ||
        net.onUnknownHost === "allow" ||
        net.onUnknownHost === "deny"
      ) {
        config.network.onUnknownHost = net.onUnknownHost;
      } else {
        logger.warn(
          `Invalid sandbox.network.onUnknownHost: ${JSON.stringify(net.onUnknownHost)}, must be "prompt", "allow", or "deny"`,
        );
      }
    }
  } else if ("network" in obj) {
    logger.warn("sandbox.network must be an object");
  }

  if (Array.isArray(obj.requireApprovalPatterns)) {
    config.requireApprovalPatterns = parseStringArray(
      obj.requireApprovalPatterns,
      "sandbox.requireApprovalPatterns",
      logger,
    );
  } else if ("requireApprovalPatterns" in obj) {
    logger.warn("sandbox.requireApprovalPatterns must be an array of strings");
  }

  if (typeof obj.strace === "object" && obj.strace !== null) {
    const strace = obj.strace as Record<string, unknown>;
    if (typeof strace.autoAllowViolations === "boolean") {
      config.strace.autoAllowViolations = strace.autoAllowViolations;
    } else if ("autoAllowViolations" in strace) {
      logger.warn("sandbox.strace.autoAllowViolations must be a boolean");
    }
  } else if ("strace" in obj) {
    logger.warn("sandbox.strace must be an object");
  }

  return config;
}
export function parseOptions(
  inputOptions: unknown,
  logger: { warn: (msg: string) => void; error: (msg: string) => void },
): MagentaOptions {
  const options: MagentaOptions = {
    profiles: [],
    activeProfile: "",
    sidebarPosition: "left",
    sidebarPositionOpts: {
      above: {
        displayHeightPercentage: 0.3,
        inputHeightPercentage: 0.1,
      },
      below: {
        displayHeightPercentage: 0.3,
        inputHeightPercentage: 0.1,
      },
      tab: {
        displayHeightPercentage: 0.8,
      },
      left: {
        widthPercentage: 0.4,
        displayHeightPercentage: 0.8,
      },
      right: {
        widthPercentage: 0.4,
        displayHeightPercentage: 0.8,
      },
    },
    maxConcurrentSubagents: 3,
    maxConcurrentFastSubagents: 8,
    autoCompactThreshold: 300000,
    sandbox: { ...DEFAULT_SANDBOX_CONFIG },
    autoContext: [],
    hierarchyContextFileNames: ["context.md", "agent.md"],
    skillsPaths: [
      BUILTIN_SKILLS_PATH,
      "~/.claude/skills",
      "~/.magenta/skills",
      ".magenta/skills",
      ".claude/skills",
    ],
    scriptsPaths: ["~/.magenta/scripts", ".magenta/scripts"],
    suppressProjectSkills: [],
    agentsPaths: [
      BUILTIN_AGENTS_PATH,
      "~/.claude/agents",
      "~/.magenta/agents",
      ".claude/agents",
      ".magenta/agents",
    ],
    mcpServers: {},
    customCommands: [],
  };

  if (typeof inputOptions === "object" && inputOptions != null) {
    const inputOptionsObj = inputOptions as { [key: string]: unknown };

    // Parse sidebar position
    const sidebarPosition = parseSidebarPosition(
      inputOptionsObj.sidebarPosition,
    );
    if (sidebarPosition) {
      options.sidebarPosition = sidebarPosition;
    }

    // Parse sidebar position opts
    const sidebarPositionOpts = parseSidebarPositionOpts(
      inputOptionsObj.sidebarPositionOpts,
    );
    if (sidebarPositionOpts) {
      options.sidebarPositionOpts = sidebarPositionOpts;
    }

    // Parse sandbox config — merge user values onto defaults
    if ("sandbox" in inputOptionsObj) {
      const parsedSandbox = parseSandboxConfig(inputOptionsObj.sandbox, logger);
      options.sandbox = mergeSandboxConfigs(
        structuredClone(DEFAULT_SANDBOX_CONFIG),
        parsedSandbox,
      );
    }

    // Parse profiles (throw errors for invalid profiles in main config)
    options.profiles = parseProfiles(inputOptionsObj.profiles, logger);

    if (options.profiles.length === 0) {
      throw new Error(`Invalid profiles provided`);
    }
    options.activeProfile = options.profiles[0].name;

    // Parse auto context
    options.autoContext = parseStringArray(
      inputOptionsObj.autoContext,
      "autoContext",
    );

    // Parse hierarchy context file names
    if ("hierarchyContextFileNames" in inputOptionsObj) {
      options.hierarchyContextFileNames = parseStringArray(
        inputOptionsObj.hierarchyContextFileNames,
        "hierarchyContextFileNames",
        logger,
      );
    }

    // Parse skills paths
    if ("skillsPaths" in inputOptionsObj) {
      const userSkillsPaths = parseStringArray(
        inputOptionsObj.skillsPaths,
        "skillsPaths",
      );
      options.skillsPaths = [BUILTIN_SKILLS_PATH, ...userSkillsPaths];
    }

    // Parse scripts paths
    if ("scriptsPaths" in inputOptionsObj) {
      options.scriptsPaths = parseStringArray(
        inputOptionsObj.scriptsPaths,
        "scriptsPaths",
      );
    }

    // Parse suppressProjectSkills
    if ("suppressProjectSkills" in inputOptionsObj) {
      options.suppressProjectSkills = parseStringArray(
        inputOptionsObj.suppressProjectSkills,
        "suppressProjectSkills",
      );
    }

    // Parse agents paths - always prepend built-in agents
    if ("agentsPaths" in inputOptionsObj) {
      const userAgentsPaths = parseStringArray(
        inputOptionsObj.agentsPaths,
        "agentsPaths",
      );
      options.agentsPaths = [BUILTIN_AGENTS_PATH, ...userAgentsPaths];
    }

    // Parse max concurrent subagents
    if (
      "maxConcurrentSubagents" in inputOptionsObj &&
      typeof inputOptionsObj.maxConcurrentSubagents === "number" &&
      inputOptionsObj.maxConcurrentSubagents > 0
    ) {
      options.maxConcurrentSubagents = inputOptionsObj.maxConcurrentSubagents;
    }

    // Parse max concurrent fast subagents
    if (
      "maxConcurrentFastSubagents" in inputOptionsObj &&
      typeof inputOptionsObj.maxConcurrentFastSubagents === "number" &&
      inputOptionsObj.maxConcurrentFastSubagents > 0
    ) {
      options.maxConcurrentFastSubagents =
        inputOptionsObj.maxConcurrentFastSubagents;
    }

    // Parse auto-compact threshold
    if (
      "autoCompactThreshold" in inputOptionsObj &&
      typeof inputOptionsObj.autoCompactThreshold === "number" &&
      inputOptionsObj.autoCompactThreshold > 0
    ) {
      options.autoCompactThreshold = inputOptionsObj.autoCompactThreshold;
    }

    // Parse auto-compact prompt
    if (
      "autoCompactPrompt" in inputOptionsObj &&
      typeof inputOptionsObj.autoCompactPrompt === "string" &&
      inputOptionsObj.autoCompactPrompt.trim().length > 0
    ) {
      options.autoCompactPrompt = inputOptionsObj.autoCompactPrompt;
    }

    // Parse LSP debounce ms
    if (
      "lspDebounceMs" in inputOptionsObj &&
      typeof inputOptionsObj.lspDebounceMs === "number" &&
      inputOptionsObj.lspDebounceMs > 0
    ) {
      options.lspDebounceMs = inputOptionsObj.lspDebounceMs;
    }

    // Parse debug flag
    if (
      "debug" in inputOptionsObj &&
      typeof inputOptionsObj.debug === "boolean"
    ) {
      options.debug = inputOptionsObj.debug;
    }

    // Parse chime volume
    if (
      "chimeVolume" in inputOptionsObj &&
      typeof inputOptionsObj.chimeVolume === "number" &&
      inputOptionsObj.chimeVolume >= 0 &&
      inputOptionsObj.chimeVolume <= 1
    ) {
      options.chimeVolume = inputOptionsObj.chimeVolume;
    } else if ("chimeVolume" in inputOptionsObj) {
      logger.warn("chimeVolume must be a number between 0.0 and 1.0");
    }

    // Parse MCP servers (throw errors for invalid MCP servers in main config)
    options.mcpServers = parseMCPServers(inputOptionsObj.mcpServers, logger);

    if ("customCommands" in inputOptionsObj) {
      options.customCommands = parseCustomCommands(
        inputOptionsObj.customCommands,
        logger,
      );
    }
  }

  return options;
}

export function parseProjectOptions(
  inputOptions: unknown,
  logger: { warn: (msg: string) => void },
): Partial<MagentaOptions> {
  const options: Partial<MagentaOptions> = {};

  if (typeof inputOptions !== "object" || inputOptions === null) {
    logger.warn("Project options must be an object");
    return options;
  }

  const inputOptionsObj = inputOptions as { [key: string]: unknown };

  // Parse sidebar position
  const sidebarPosition = parseSidebarPosition(
    inputOptionsObj.sidebarPosition,
    logger,
  );
  if (sidebarPosition) {
    options.sidebarPosition = sidebarPosition;
  }

  // Parse sandbox config
  if ("sandbox" in inputOptionsObj) {
    options.sandbox = parseSandboxConfig(inputOptionsObj.sandbox, logger);
  }

  // Parse profiles
  if ("profiles" in inputOptionsObj) {
    const profiles = parseProfiles(inputOptionsObj.profiles, logger);
    if (profiles.length > 0) {
      options.profiles = profiles;
      // Set active profile to first one if not explicitly set
      if (!("activeProfile" in inputOptionsObj)) {
        options.activeProfile = profiles[0].name;
      }
    }
  }

  // Parse active profile
  if ("activeProfile" in inputOptionsObj) {
    if (typeof inputOptionsObj.activeProfile === "string") {
      options.activeProfile = inputOptionsObj.activeProfile;
    } else {
      logger.warn("activeProfile must be a string");
    }
  }

  // Parse auto context
  if ("autoContext" in inputOptionsObj) {
    options.autoContext = parseStringArray(
      inputOptionsObj.autoContext,
      "autoContext",
      logger,
    );
  }

  // Parse hierarchy context file names
  if ("hierarchyContextFileNames" in inputOptionsObj) {
    options.hierarchyContextFileNames = parseStringArray(
      inputOptionsObj.hierarchyContextFileNames,
      "hierarchyContextFileNames",
      logger,
    );
  }

  // Parse skills paths
  if ("skillsPaths" in inputOptionsObj) {
    options.skillsPaths = parseStringArray(
      inputOptionsObj.skillsPaths,
      "skillsPaths",
      logger,
    );
  }

  // Parse scripts paths
  if ("scriptsPaths" in inputOptionsObj) {
    options.scriptsPaths = parseStringArray(
      inputOptionsObj.scriptsPaths,
      "scriptsPaths",
      logger,
    );
  }

  // Parse suppressProjectSkills (filtered out by loadProjectSettings)
  if ("suppressProjectSkills" in inputOptionsObj) {
    options.suppressProjectSkills = parseStringArray(
      inputOptionsObj.suppressProjectSkills,
      "suppressProjectSkills",
      logger,
    );
  }

  // Parse agents paths
  if ("agentsPaths" in inputOptionsObj) {
    options.agentsPaths = parseStringArray(
      inputOptionsObj.agentsPaths,
      "agentsPaths",
      logger,
    );
  }

  // Parse max concurrent subagents
  if (
    "maxConcurrentSubagents" in inputOptionsObj &&
    typeof inputOptionsObj.maxConcurrentSubagents === "number" &&
    inputOptionsObj.maxConcurrentSubagents > 0
  ) {
    options.maxConcurrentSubagents = inputOptionsObj.maxConcurrentSubagents;
  }

  // Parse max concurrent fast subagents
  if (
    "maxConcurrentFastSubagents" in inputOptionsObj &&
    typeof inputOptionsObj.maxConcurrentFastSubagents === "number" &&
    inputOptionsObj.maxConcurrentFastSubagents > 0
  ) {
    options.maxConcurrentFastSubagents =
      inputOptionsObj.maxConcurrentFastSubagents;
  }

  // Parse auto-compact threshold
  if (
    "autoCompactThreshold" in inputOptionsObj &&
    typeof inputOptionsObj.autoCompactThreshold === "number" &&
    inputOptionsObj.autoCompactThreshold > 0
  ) {
    options.autoCompactThreshold = inputOptionsObj.autoCompactThreshold;
  }

  // Parse auto-compact prompt
  if (
    "autoCompactPrompt" in inputOptionsObj &&
    typeof inputOptionsObj.autoCompactPrompt === "string" &&
    inputOptionsObj.autoCompactPrompt.trim().length > 0
  ) {
    options.autoCompactPrompt = inputOptionsObj.autoCompactPrompt;
  }

  // Parse LSP debounce ms
  if (
    "lspDebounceMs" in inputOptionsObj &&
    typeof inputOptionsObj.lspDebounceMs === "number" &&
    inputOptionsObj.lspDebounceMs > 0
  ) {
    options.lspDebounceMs = inputOptionsObj.lspDebounceMs;
  }

  // Parse debug flag
  if (
    "debug" in inputOptionsObj &&
    typeof inputOptionsObj.debug === "boolean"
  ) {
    options.debug = inputOptionsObj.debug;
  }

  if (
    "chimeVolume" in inputOptionsObj &&
    typeof inputOptionsObj.chimeVolume === "number" &&
    inputOptionsObj.chimeVolume >= 0 &&
    inputOptionsObj.chimeVolume <= 1
  ) {
    options.chimeVolume = inputOptionsObj.chimeVolume;
  } else if ("chimeVolume" in inputOptionsObj) {
    logger.warn("chimeVolume must be a number between 0.0 and 1.0");
  }

  if (
    "bellOnNotify" in inputOptionsObj &&
    typeof inputOptionsObj.bellOnNotify === "boolean"
  ) {
    options.bellOnNotify = inputOptionsObj.bellOnNotify;
  }

  // Parse MCP servers
  if ("mcpServers" in inputOptionsObj) {
    options.mcpServers = parseMCPServers(inputOptionsObj.mcpServers, logger);
  }

  if ("customCommands" in inputOptionsObj) {
    options.customCommands = parseCustomCommands(
      inputOptionsObj.customCommands,
      logger,
    );
  }

  return options;
}

export function loadUserSettings(
  homeDir: string,
  logger: {
    warn: (msg: string) => void;
  },
): Partial<MagentaOptions> | undefined {
  const settingsPath = path.join(homeDir, ".magenta", "options.json");

  try {
    if (fs.existsSync(settingsPath)) {
      const fileContent = fs.readFileSync(settingsPath, "utf8");
      const rawSettings = JSON.parse(fileContent) as unknown;

      return parseProjectOptions(rawSettings, logger);
    }
  } catch (error) {
    logger.warn(
      `Failed to parse user settings at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return undefined;
}

export function loadProjectSettings(
  cwd: NvimCwd,
  logger: { warn: (msg: string) => void },
): Partial<MagentaOptions> | undefined {
  const settingsPath = path.join(cwd, ".magenta", "options.json");

  try {
    if (fs.existsSync(settingsPath)) {
      const fileContent = fs.readFileSync(settingsPath, "utf8");
      const rawSettings = JSON.parse(fileContent) as unknown;

      const parsed = parseProjectOptions(rawSettings, logger);
      if ("suppressProjectSkills" in parsed) {
        logger.warn(
          "`suppressProjectSkills` is a user-level option and is ignored when set in project options.",
        );
        delete parsed.suppressProjectSkills;
      }
      return parsed;
    }
  } catch (error) {
    logger.warn(
      `Failed to parse project settings at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return undefined;
}

export function mergeOptions(
  baseOptions: MagentaOptions,
  projectSettings: Partial<MagentaOptions>,
): MagentaOptions {
  const merged: MagentaOptions = { ...baseOptions };

  if (projectSettings.profiles && projectSettings.profiles.length > 0) {
    merged.profiles = projectSettings.profiles;
    merged.activeProfile = projectSettings.profiles[0].name;
  }

  if (projectSettings.sandbox) {
    merged.sandbox = mergeSandboxConfigs(
      baseOptions.sandbox,
      projectSettings.sandbox,
    );
  }

  if (projectSettings.autoContext) {
    merged.autoContext = [
      ...baseOptions.autoContext,
      ...projectSettings.autoContext,
    ];
  }

  if (projectSettings.hierarchyContextFileNames) {
    merged.hierarchyContextFileNames =
      projectSettings.hierarchyContextFileNames;
  }

  if (projectSettings.skillsPaths) {
    merged.skillsPaths = [
      ...baseOptions.skillsPaths,
      ...projectSettings.skillsPaths,
    ];
  }

  if (projectSettings.scriptsPaths) {
    merged.scriptsPaths = [
      ...baseOptions.scriptsPaths,
      ...projectSettings.scriptsPaths,
    ];
  }

  if (projectSettings.suppressProjectSkills) {
    merged.suppressProjectSkills = projectSettings.suppressProjectSkills;
  }

  if (projectSettings.agentsPaths) {
    merged.agentsPaths = [
      ...baseOptions.agentsPaths,
      ...projectSettings.agentsPaths,
    ];
  }

  if (projectSettings.sidebarPosition !== undefined) {
    merged.sidebarPosition = projectSettings.sidebarPosition;
  }

  if (projectSettings.maxConcurrentSubagents !== undefined) {
    merged.maxConcurrentSubagents = projectSettings.maxConcurrentSubagents;
  }

  if (projectSettings.maxConcurrentFastSubagents !== undefined) {
    merged.maxConcurrentFastSubagents =
      projectSettings.maxConcurrentFastSubagents;
  }

  if (projectSettings.autoCompactThreshold !== undefined) {
    merged.autoCompactThreshold = projectSettings.autoCompactThreshold;
  }

  if (projectSettings.autoCompactPrompt !== undefined) {
    merged.autoCompactPrompt = projectSettings.autoCompactPrompt;
  }

  if (projectSettings.lspDebounceMs !== undefined) {
    merged.lspDebounceMs = projectSettings.lspDebounceMs;
  }

  if (projectSettings.debug !== undefined) {
    merged.debug = projectSettings.debug;
  }

  if (projectSettings.chimeVolume !== undefined) {
    merged.chimeVolume = projectSettings.chimeVolume;
  }

  if (projectSettings.bellOnNotify !== undefined) {
    merged.bellOnNotify = projectSettings.bellOnNotify;
  }

  if (projectSettings.mcpServers) {
    merged.mcpServers = {
      ...baseOptions.mcpServers,
      ...projectSettings.mcpServers,
    };
  }

  if (projectSettings.customCommands) {
    merged.customCommands = [
      ...baseOptions.customCommands,
      ...projectSettings.customCommands,
    ];
  }

  return merged;
}

export function getActiveProfile(profiles: Profile[], activeProfile: string) {
  const profile = profiles.find((p) => p.name === activeProfile);
  if (!profile) {
    throw new Error(`Profile ${activeProfile} not found.`);
  }
  return profile;
}
