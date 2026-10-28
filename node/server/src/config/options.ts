import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_NAMES,
  type ProviderName,
} from "../providers/provider-types.ts";
import {
  DEFAULT_SANDBOX_CONFIG,
  type OnUnknownHostBehavior,
  type SandboxConfig,
} from "../sandbox-config.ts";
import type { CustomCommand } from "../submission/commands/types.ts";
import { type ServerName, validateServerName } from "../tools/mcp/types.ts";
import type { ProjectDir } from "../utils/files.ts";
export {
  DEFAULT_SANDBOX_CONFIG,
  type OnUnknownHostBehavior,
  type SandboxConfig,
};
// Source modules and the single-file bundle live at different depths.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isSource = path.basename(__dirname) === "config";
export const PLUGIN_ROOT = path.resolve(
  __dirname,
  isSource ? "../../../.." : "..",
);
export const BUILTIN_AGENTS_PATH = path.resolve(
  __dirname,
  isSource ? "../agents" : "server/src/agents",
);
export const BUILTIN_SKILLS_PATH = path.join(PLUGIN_ROOT, "skills");
export const BUILTIN_SDK_PATH = path.join(PLUGIN_ROOT, "sdk");
// Default models by provider
const DEFAULT_MODELS: Record<
  ProviderName,
  { model: string; fastModel?: string; thinkingModel?: string }
> = {
  anthropic: {
    model: "claude-sonnet-5",
    fastModel: "claude-haiku-5-5",
    thinkingModel: "claude-opus-5",
  },
  openai: {
    model: "gpt-5.4",
    fastModel: "gpt-5.4-mini",
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
    fastModel: "claude-haiku-5-5",
    thinkingModel: "claude-opus-5",
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
  // "chatgpt" and "bedrock" are openai-only: ChatGPT subscription auth via the
  // codex CLI, and SigV4-signed access to the bedrock-mantle endpoint
  authType?: "key" | "max" | "keychain" | "chatgpt" | "bedrock";
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
export type { CustomCommand };
export const DEFAULT_AUTO_COMPACT_PROMPT =
  "Continue with the task you were working on before the conversation was automatically compacted.";
export type ServerOptions = {
  profiles: Profile[];
  activeProfile: string;
  sandbox: SandboxConfig;
  autoContext: string[];
  hierarchyContextFileNames: string[];
  skillsPaths: string[];
  scriptsPaths: string[];
  suppressProjectSkills: string[];
  agentsPaths: string[];
  maxConcurrentSubagents: number;
  maxConcurrentFastSubagents: number;
  dockerfile?: string;
  autoCompactThreshold: number;
  autoCompactPrompt: string;
  mcpServers: { [serverName: ServerName]: MCPServerConfig };
  customCommands: CustomCommand[];
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
        const legal =
          provider === "anthropic"
            ? ["key", "max", "keychain"]
            : provider === "openai"
              ? ["key", "chatgpt", "bedrock"]
              : ["key"];
        if (typeof p.authType === "string" && legal.includes(p.authType)) {
          out.authType = p.authType as NonNullable<Profile["authType"]>;
        } else {
          logger.warn(
            `Invalid authType ${JSON.stringify(p.authType)} in profile ${p.name} for provider ${provider}, must be one of ${legal.map((a) => `"${a}"`).join(", ")}`,
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
/** Used when neither options file configures profiles. */
const DEFAULT_PROFILES: unknown[] = [
  {
    name: "claude-sonnet-5",
    provider: "anthropic",
    model: "claude-sonnet-5",
    thinkingModel: "claude-opus-4-8",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
    thinking: { enabled: true, effort: "medium" },
  },
  {
    name: "claude-opus-4-8",
    provider: "anthropic",
    model: "claude-opus-4-8",
    apiKeyEnvVar: "ANTHROPIC_API_KEY",
  },
  {
    name: "claude-max",
    provider: "anthropic",
    model: "claude-opus-4-8",
    authType: "max",
  },
  {
    name: "claude-keychain",
    provider: "anthropic",
    model: "claude-opus-4-8",
    authType: "keychain",
  },
  {
    name: "gpt-4o",
    provider: "openai",
    model: "gpt-4o",
    apiKeyEnvVar: "OPENAI_API_KEY",
  },
];
// Globs run case-insensitively, so lowercase names cover every spelling.
const DEFAULT_AUTO_CONTEXT = [
  "~/.magenta/context.md",
  "~/.claude/context.md",
  "context.md",
  "claude.md",
  ".magenta/*.md",
];
const DEFAULT_CUSTOM_COMMANDS: CustomCommand[] = [
  {
    name: "@nedit",
    text: "DO NOT MAKE ANY EDITS TO CODE. Do not use any tools that allow you to edit code. Do not execute bash commands which edit code. NO EDITING WHATSOEVER.",
    description: "Disable all code editing functionality",
  },
];
export function parseOptions(
  inputOptions: unknown,
  logger: { warn: (msg: string) => void; error: (msg: string) => void },
): ServerOptions {
  const defaultProfiles = parseProfiles(DEFAULT_PROFILES, logger);
  const options: ServerOptions = {
    profiles: defaultProfiles,
    activeProfile: defaultProfiles[0].name,
    maxConcurrentSubagents: 3,
    maxConcurrentFastSubagents: 8,
    autoCompactThreshold: 300000,
    autoCompactPrompt: DEFAULT_AUTO_COMPACT_PROMPT,
    sandbox: { ...DEFAULT_SANDBOX_CONFIG },
    autoContext: [...DEFAULT_AUTO_CONTEXT],
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
    customCommands: structuredClone(DEFAULT_CUSTOM_COMMANDS),
  };
  if (typeof inputOptions === "object" && inputOptions != null) {
    const inputOptionsObj = inputOptions as { [key: string]: unknown };
    // Parse sandbox config — merge user values onto defaults
    if ("sandbox" in inputOptionsObj) {
      const parsedSandbox = parseSandboxConfig(inputOptionsObj.sandbox, logger);
      options.sandbox = mergeSandboxConfigs(
        structuredClone(DEFAULT_SANDBOX_CONFIG),
        parsedSandbox,
      );
    }
    // Parse profiles (throw errors for invalid profiles in main config)
    if ("profiles" in inputOptionsObj) {
      const profiles = parseProfiles(inputOptionsObj.profiles, logger);
      if (profiles.length > 0) {
        options.profiles = profiles;
        options.activeProfile = profiles[0].name;
      } else {
        logger.warn("No valid profiles provided, using the default profiles");
      }
    }
    // Parse auto context
    if ("autoContext" in inputOptionsObj) {
      options.autoContext = parseStringArray(
        inputOptionsObj.autoContext,
        "autoContext",
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
    if (
      "dockerfile" in inputOptionsObj &&
      typeof inputOptionsObj.dockerfile === "string" &&
      inputOptionsObj.dockerfile.length > 0
    ) {
      options.dockerfile = inputOptionsObj.dockerfile;
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
    // Parse MCP servers (throw errors for invalid MCP servers in main config)
    if ("mcpServers" in inputOptionsObj) {
      options.mcpServers = parseMCPServers(inputOptionsObj.mcpServers, logger);
    }
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
): Partial<ServerOptions> {
  const options: Partial<ServerOptions> = {};
  if (typeof inputOptions !== "object" || inputOptions === null) {
    logger.warn("Project options must be an object");
    return options;
  }
  const inputOptionsObj = inputOptions as { [key: string]: unknown };
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
  if (
    "dockerfile" in inputOptionsObj &&
    typeof inputOptionsObj.dockerfile === "string" &&
    inputOptionsObj.dockerfile.length > 0
  ) {
    options.dockerfile = inputOptionsObj.dockerfile;
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
/** `~/.magenta/options.json` is the full server configuration, parsed over
 * the defaults. */
export function loadUserOptions(
  homeDir: string,
  logger: { warn: (msg: string) => void; error: (msg: string) => void },
): ServerOptions {
  const settingsPath = path.join(homeDir, ".magenta", "options.json");
  let raw: unknown = {};
  try {
    if (fs.existsSync(settingsPath)) {
      raw = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as unknown;
    }
  } catch (error) {
    logger.warn(
      `Failed to parse user settings at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseOptions(raw, logger);
}
export function loadProjectSettings(
  projectDir: ProjectDir,
  logger: { warn: (msg: string) => void },
): Partial<ServerOptions> | undefined {
  const settingsPath = path.join(projectDir, ".magenta", "options.json");
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
  baseOptions: ServerOptions,
  projectSettings: Partial<ServerOptions>,
): ServerOptions {
  const merged: ServerOptions = { ...baseOptions };
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
  if (projectSettings.maxConcurrentSubagents !== undefined) {
    merged.maxConcurrentSubagents = projectSettings.maxConcurrentSubagents;
  }
  if (projectSettings.dockerfile !== undefined) {
    merged.dockerfile = projectSettings.dockerfile;
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
