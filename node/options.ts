import { PROVIDER_NAMES, type ProviderName } from "./providers/provider";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { ServerName } from "./tools/mcp/types";
import { validateServerName } from "./tools/mcp/types";
import type { NvimCwd } from "./utils/files";
import {
  BUILTIN_COMMAND_PERMISSIONS,
  type ArgSpec,
  type CommandPermissions,
} from "./tools/bash-parser/permissions";

// Get the path to the built-in skills directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const BUILTIN_SKILLS_PATH = path.join(__dirname, "skills");

// Default models by provider
const DEFAULT_MODELS: Record<
  ProviderName,
  { model: string; fastModel?: string }
> = {
  anthropic: {
    model: "claude-opus-4-5",
    fastModel: "claude-haiku-4-5",
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
    model: "claude-opus-4-5",
    fastModel: "claude-haiku-4-5",
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
  baseUrl?: string;
  apiKeyEnvVar?: string;
  authType?: "key" | "max"; // New field for authentication type
  promptCaching?: boolean; // Primarily used by Bedrock provider
  env?: Record<string, string>; // Environment variables to set before provider initialization (e.g., AWS_PROFILE, AWS_REGION)
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

// Re-export permission types for convenience
export type { ArgSpec, CommandPermissions };

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

export type EditPredictionProfile = {
  name: string;
  provider: ProviderName;
  model: string;
  baseUrl?: string | undefined;
  apiKeyEnvVar?: string | undefined;
  authType?: "key" | "max" | undefined;
};

export type CustomCommand = {
  name: string;
  text: string;
  description?: string;
};

export type EditPredictionOptions = {
  changeTrackerMaxChanges?: number;
  recentChangeTokenBudget?: number;
  systemPrompt?: string;
  systemPromptAppend?: string;
  profile?: EditPredictionProfile;
};

export type PKBEmbeddingModel =
  | {
      provider: "bedrock";
      model: "cohere.embed-v4:0";
      region?: string | undefined;
    }
  | {
      provider: "mock";
    };

export type PKBOptions = {
  path?: string | undefined;
  embeddingModel: PKBEmbeddingModel;
  updateIntervalMs?: number;
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
  customCommands: CustomCommand[];
  lspDebounceMs?: number;
  debug?: boolean;
  chimeVolume?: number; // Volume from 0.0 (silent) to 1.0 (full), defaults to 0.3
  // New structured options
  editPrediction?: EditPredictionOptions;
  pkb?: PKBOptions;
};

// Reusable parsing helpers
function parseEditPredictionProfile(
  profileInput: unknown,
  logger: { warn: (msg: string) => void },
): EditPredictionProfile | undefined {
  if (typeof profileInput !== "object" || profileInput === null) {
    logger.warn("editPrediction.profile must be an object");
    return undefined;
  }

  const p = profileInput as { [key: string]: unknown };

  if (
    !(
      typeof p["provider"] === "string" &&
      PROVIDER_NAMES.indexOf(p["provider"] as ProviderName) !== -1
    )
  ) {
    logger.warn("editPrediction.profile must have a valid provider field");
    return undefined;
  }

  const provider = p["provider"] as ProviderName;
  const defaults = DEFAULT_MODELS[provider];

  const profile: EditPredictionProfile = {
    name: "edit-prediction",
    provider,
    model: typeof p["model"] === "string" ? p["model"] : defaults.model,
  };

  if ("baseUrl" in p) {
    if (typeof p["baseUrl"] === "string") {
      profile.baseUrl = p["baseUrl"];
    } else {
      logger.warn("Invalid baseUrl in editPrediction.profile, ignoring field");
    }
  }

  if ("apiKeyEnvVar" in p) {
    if (typeof p["apiKeyEnvVar"] === "string") {
      profile.apiKeyEnvVar = p["apiKeyEnvVar"];
    } else {
      logger.warn(
        "Invalid apiKeyEnvVar in editPrediction.profile, ignoring field",
      );
    }
  }

  if ("authType" in p) {
    if (
      typeof p["authType"] === "string" &&
      (p["authType"] === "key" || p["authType"] === "max")
    ) {
      profile.authType = p["authType"];
    } else {
      logger.warn(
        'Invalid authType in editPrediction.profile, must be "key" or "max"',
      );
    }
  }

  return profile;
}

function parsePKBOptions(
  pkbInput: Record<string, unknown>,
  logger: { warn: (msg: string) => void },
): PKBOptions | undefined {
  // Validate embeddingModel - required field
  if (
    !("embeddingModel" in pkbInput) ||
    typeof pkbInput["embeddingModel"] !== "object" ||
    pkbInput["embeddingModel"] === null
  ) {
    logger.warn("pkb.embeddingModel must be an object");
    return undefined;
  }

  const embeddingModelInput = pkbInput["embeddingModel"] as Record<
    string,
    unknown
  >;

  if (typeof embeddingModelInput["provider"] !== "string") {
    logger.warn("pkb.embeddingModel.provider must be a string");
    return undefined;
  }

  const provider = embeddingModelInput["provider"];

  let embeddingModel: PKBEmbeddingModel;

  if (provider === "mock") {
    embeddingModel = { provider: "mock" };
  } else if (provider === "bedrock") {
    if (embeddingModelInput["model"] !== "cohere.embed-v4:0") {
      logger.warn(
        'pkb.embeddingModel.model must be "cohere.embed-v4:0" for bedrock provider',
      );
      return undefined;
    }
    embeddingModel = {
      provider: "bedrock",
      model: "cohere.embed-v4:0",
      region:
        typeof embeddingModelInput["region"] === "string"
          ? embeddingModelInput["region"]
          : undefined,
    };
  } else {
    logger.warn(`Unknown pkb.embeddingModel.provider: ${provider}`);
    return undefined;
  }

  const pkbOptions: PKBOptions = {
    embeddingModel,
  };

  // Parse optional path
  if ("path" in pkbInput) {
    if (typeof pkbInput["path"] === "string") {
      pkbOptions.path = pkbInput["path"];
    } else {
      logger.warn("pkb.path must be a string");
    }
  }

  // Parse optional updateIntervalMs
  if ("updateIntervalMs" in pkbInput) {
    if (typeof pkbInput["updateIntervalMs"] === "number") {
      pkbOptions.updateIntervalMs = pkbInput["updateIntervalMs"];
    } else {
      logger.warn("pkb.updateIntervalMs must be a number");
    }
  }

  return pkbOptions;
}

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
          typeof p["name"] === "string" &&
          typeof p["provider"] === "string" &&
          PROVIDER_NAMES.indexOf(p["provider"] as ProviderName) !== -1
        )
      ) {
        logger.warn(
          `Skipping profile with missing required fields: ${JSON.stringify(p)}`,
        );
        continue;
      }

      const provider = p["provider"] as ProviderName;
      const defaults = DEFAULT_MODELS[provider];

      const model =
        typeof p["model"] === "string" ? p["model"] : defaults.model;

      const out: Profile = {
        name: p["name"],
        provider,
        model,
        fastModel:
          typeof p["fastModel"] === "string"
            ? p["fastModel"]
            : (defaults.fastModel ?? model),
      };

      if ("baseUrl" in p) {
        if (typeof p["baseUrl"] === "string") {
          out.baseUrl = p["baseUrl"];
        } else {
          logger.warn(
            `Invalid baseUrl in profile ${p["name"]}, ignoring field`,
          );
        }
      }

      if ("apiKeyEnvVar" in p) {
        if (typeof p["apiKeyEnvVar"] === "string") {
          out.apiKeyEnvVar = p["apiKeyEnvVar"];
        } else {
          logger.warn(
            `Invalid apiKeyEnvVar in profile ${p["name"]}, ignoring field`,
          );
        }
      }

      if ("authType" in p) {
        if (
          typeof p["authType"] === "string" &&
          (p["authType"] === "key" || p["authType"] === "max")
        ) {
          out.authType = p["authType"];
        } else {
          logger.warn(
            `Invalid authType in profile ${p["name"]}, must be "key" or "max"`,
          );
        }
      }

      if ("promptCaching" in p) {
        if (typeof p["promptCaching"] === "boolean") {
          out.promptCaching = p["promptCaching"];
        } else {
          logger.warn(
            `Invalid promptCaching in profile ${p["name"]}, ignoring field`,
          );
        }
      }

      if ("env" in p) {
        if (
          typeof p["env"] === "object" &&
          p["env"] !== null &&
          !Array.isArray(p["env"])
        ) {
          const env: Record<string, string> = {};
          const envObj = p["env"] as Record<string, unknown>;

          for (const [envKey, envValue] of Object.entries(envObj)) {
            if (typeof envValue === "string") {
              env[envKey] = envValue;
            } else {
              logger.warn(
                `Skipping non-string env value in profile ${p["name"]}: ${envKey}=${JSON.stringify(envValue)}`,
              );
            }
          }

          if (Object.keys(env).length > 0) {
            out.env = env;
          }
        } else {
          logger.warn(`Invalid env in profile ${p["name"]}, must be an object`);
        }
      }

      if ("thinking" in p) {
        if (typeof p["thinking"] === "object" && p["thinking"] !== null) {
          const thinking = p["thinking"] as { [key: string]: unknown };
          if (typeof thinking["enabled"] === "boolean") {
            out.thinking = {
              enabled: thinking["enabled"],
            };
            if (
              typeof thinking["budgetTokens"] === "number" &&
              thinking["budgetTokens"] >= 1024
            ) {
              out.thinking.budgetTokens = thinking["budgetTokens"];
            } else if ("budgetTokens" in thinking) {
              logger.warn(
                `Invalid budgetTokens in profile ${p["name"]}, must be a number >= 1024`,
              );
            }
          } else {
            logger.warn(
              `Invalid thinking config in profile ${p["name"]}, must have enabled boolean field`,
            );
          }
        } else {
          logger.warn(
            `Invalid thinking in profile ${p["name"]}, must be an object`,
          );
        }
      }

      if ("reasoning" in p) {
        if (typeof p["reasoning"] === "object" && p["reasoning"] !== null) {
          const reasoning = p["reasoning"] as { [key: string]: unknown };
          out.reasoning = {};

          if ("effort" in reasoning) {
            if (
              typeof reasoning["effort"] === "string" &&
              ["low", "medium", "high"].includes(reasoning["effort"])
            ) {
              out.reasoning.effort = reasoning["effort"] as
                | "low"
                | "medium"
                | "high";
            } else {
              logger.warn(
                `Invalid effort in profile ${p["name"]}, must be "low", "medium", or "high"`,
              );
            }
          }

          if ("summary" in reasoning) {
            if (
              typeof reasoning["summary"] === "string" &&
              ["auto", "concise", "detailed"].includes(reasoning["summary"])
            ) {
              out.reasoning.summary = reasoning["summary"] as
                | "auto"
                | "concise"
                | "detailed";
            } else {
              logger.warn(
                `Invalid summary in profile ${p["name"]}, must be "auto", "concise", or "detailed"`,
              );
            }
          }
        } else {
          logger.warn(
            `Invalid reasoning in profile ${p["name"]}, must be an object`,
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
    input == "above" ||
    input == "below" ||
    input == "tab" ||
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
          typeof sideOptsObj["widthPercentage"] === "number" &&
          typeof sideOptsObj["displayHeightPercentage"] === "number"
        ) {
          result[side] = {
            widthPercentage: sideOptsObj["widthPercentage"],
            displayHeightPercentage: sideOptsObj["displayHeightPercentage"],
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
          typeof sideOptsObj["displayHeightPercentage"] === "number" &&
          typeof sideOptsObj["inputHeightPercentage"] === "number"
        ) {
          result[side] = {
            displayHeightPercentage: sideOptsObj["displayHeightPercentage"],
            inputHeightPercentage: sideOptsObj["inputHeightPercentage"],
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
    const tabOpts = opts["tab"];
    if (typeof tabOpts === "object" && tabOpts !== null) {
      const tabOptsObj = tabOpts as { [key: string]: unknown };
      if (typeof tabOptsObj["displayHeightPercentage"] === "number") {
        result.tab = {
          displayHeightPercentage: tabOptsObj["displayHeightPercentage"],
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

function parseArgSpec(
  argSpec: unknown,
  logger: { warn: (msg: string) => void },
  path: string,
): ArgSpec | undefined {
  if (typeof argSpec === "string") {
    return argSpec;
  }
  if (typeof argSpec === "object" && argSpec !== null) {
    const spec = argSpec as Record<string, unknown>;

    // Check for type-based discriminated union
    if (typeof spec["type"] === "string") {
      switch (spec["type"]) {
        case "file":
          return { type: "file" };
        case "restFiles":
          return { type: "restFiles" };
        case "restAny":
          return { type: "restAny" };
        case "any":
          return { type: "any" };
        case "pattern":
          if (typeof spec["pattern"] === "string") {
            return { type: "pattern", pattern: spec["pattern"] };
          }
          logger.warn(
            `Invalid pattern ArgSpec at ${path}: missing pattern string`,
          );
          return undefined;
        case "group":
          if (Array.isArray(spec["args"])) {
            const groupArgs: ArgSpec[] = [];
            const argsArray = spec["args"] as Array<unknown>;
            for (let i = 0; i < argsArray.length; i++) {
              const parsed = parseArgSpec(
                argsArray[i],
                logger,
                `${path}.args[${i}]`,
              );
              if (parsed === undefined) {
                return undefined;
              }
              groupArgs.push(parsed);
            }
            const result: ArgSpec = { type: "group", args: groupArgs };
            if (spec["optional"] === true) {
              result.optional = true;
            }
            if (spec["anyOrder"] === true) {
              result.anyOrder = true;
            }
            return result;
          }
          logger.warn(`Invalid group ArgSpec at ${path}: missing args array`);
          return undefined;
        default:
          logger.warn(`Invalid ArgSpec type at ${path}: "${spec["type"]}"`);
          return undefined;
      }
    }

    // Legacy support for old format
    if (spec["file"] === true && Object.keys(spec).length === 1) {
      return { type: "file" };
    }
    if (spec["restFiles"] === true && Object.keys(spec).length === 1) {
      return { type: "restFiles" };
    }
    if (spec["any"] === true && Object.keys(spec).length === 1) {
      return { type: "any" };
    }
    if (
      "pattern" in spec &&
      typeof spec["pattern"] === "string" &&
      Object.keys(spec).length === 1
    ) {
      return { type: "pattern", pattern: spec["pattern"] };
    }
    if (Array.isArray(spec["optional"])) {
      const optionalSpecs: ArgSpec[] = [];
      const optionalArray = spec["optional"] as Array<unknown>;
      for (let i = 0; i < optionalArray.length; i++) {
        const parsed = parseArgSpec(
          optionalArray[i],
          logger,
          `${path}.optional[${i}]`,
        );
        if (parsed === undefined) {
          return undefined;
        }
        optionalSpecs.push(parsed);
      }
      return { type: "group", args: optionalSpecs, optional: true };
    }

    logger.warn(
      `Invalid ArgSpec at ${path}: must be string or object with type field`,
    );
    return undefined;
  }
  logger.warn(
    `Invalid ArgSpec at ${path}: expected string or object, got ${typeof argSpec}`,
  );
  return undefined;
}

function parseCommandPatterns(
  input: unknown,
  logger: { warn: (msg: string) => void },
  path: string,
): ArgSpec[][] {
  if (!Array.isArray(input)) {
    logger.warn(`${path} must be an array`);
    return [];
  }

  const patterns: ArgSpec[][] = [];
  for (let i = 0; i < input.length; i++) {
    const pattern: unknown = input[i];
    if (Array.isArray(pattern)) {
      const parsedPattern: ArgSpec[] = [];
      let valid = true;
      for (let j = 0; j < pattern.length; j++) {
        const parsed = parseArgSpec(pattern[j], logger, `${path}[${i}][${j}]`);
        if (parsed) {
          parsedPattern.push(parsed);
        } else {
          valid = false;
        }
      }
      if (valid && parsedPattern.length > 0) {
        patterns.push(parsedPattern);
      }
    } else {
      logger.warn(`${path}[${i}] must be an array`);
    }
  }

  return patterns;
}

function parseCommandConfig(
  input: unknown,
  logger: { warn: (msg: string) => void },
): CommandPermissions | undefined {
  if (input === undefined) {
    return undefined;
  }

  if (typeof input !== "object" || input === null) {
    logger.warn("commandConfig must be an object");
    return undefined;
  }

  const inputObj = input as Record<string, unknown>;
  const result: CommandPermissions = {
    commands: [],
    pipeCommands: [],
  };

  if ("commands" in inputObj) {
    result.commands = parseCommandPatterns(
      inputObj["commands"],
      logger,
      "commandConfig.commands",
    );
  }

  if ("pipeCommands" in inputObj) {
    result.pipeCommands = parseCommandPatterns(
      inputObj["pipeCommands"],
      logger,
      "commandConfig.pipeCommands",
    );
  }

  if (result.commands.length === 0 && result.pipeCommands.length === 0) {
    return undefined;
  }

  return result;
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
    commandConfig: BUILTIN_COMMAND_PERMISSIONS,
    autoContext: [],
    skillsPaths: [
      BUILTIN_SKILLS_PATH,
      "~/.claude/skills",
      "~/.magenta/skills",
      ".magenta/skills",
      ".claude/skills",
    ],
    mcpServers: {},
    getFileAutoAllowGlobs: [],
    customCommands: [],
  };

  if (typeof inputOptions == "object" && inputOptions != null) {
    const inputOptionsObj = inputOptions as { [key: string]: unknown };

    // Parse sidebar position
    const sidebarPosition = parseSidebarPosition(
      inputOptionsObj["sidebarPosition"],
    );
    if (sidebarPosition) {
      options.sidebarPosition = sidebarPosition;
    }

    // Parse sidebar position opts
    const sidebarPositionOpts = parseSidebarPositionOpts(
      inputOptionsObj["sidebarPositionOpts"],
    );
    if (sidebarPositionOpts) {
      options.sidebarPositionOpts = sidebarPositionOpts;
    }

    // Parse command config - merge with builtins
    if ("commandConfig" in inputOptionsObj) {
      const commandConfig = parseCommandConfig(
        inputOptionsObj["commandConfig"],
        logger,
      );
      if (commandConfig) {
        options.commandConfig = mergeCommandConfig(
          BUILTIN_COMMAND_PERMISSIONS,
          commandConfig,
        );
      }
    }

    // Parse profiles (throw errors for invalid profiles in main config)
    options.profiles = parseProfiles(inputOptionsObj["profiles"], logger);

    if (options.profiles.length == 0) {
      throw new Error(`Invalid profiles provided`);
    }
    options.activeProfile = options.profiles[0].name;

    // Parse auto context
    options.autoContext = parseStringArray(
      inputOptionsObj["autoContext"],
      "autoContext",
    );

    // Parse skills paths - always prepend built-in skills
    if ("skillsPaths" in inputOptionsObj) {
      const userSkillsPaths = parseStringArray(
        inputOptionsObj["skillsPaths"],
        "skillsPaths",
      );
      options.skillsPaths = [BUILTIN_SKILLS_PATH, ...userSkillsPaths];
    }

    // Parse getFile auto allow globs
    options.getFileAutoAllowGlobs = parseStringArray(
      inputOptionsObj["getFileAutoAllowGlobs"],
      "getFileAutoAllowGlobs",
    );

    // Parse max concurrent subagents
    if (
      "maxConcurrentSubagents" in inputOptionsObj &&
      typeof inputOptionsObj["maxConcurrentSubagents"] === "number" &&
      inputOptionsObj["maxConcurrentSubagents"] > 0
    ) {
      options.maxConcurrentSubagents =
        inputOptionsObj["maxConcurrentSubagents"];
    }

    // Parse LSP debounce ms
    if (
      "lspDebounceMs" in inputOptionsObj &&
      typeof inputOptionsObj["lspDebounceMs"] === "number" &&
      inputOptionsObj["lspDebounceMs"] > 0
    ) {
      options.lspDebounceMs = inputOptionsObj["lspDebounceMs"];
    }

    // Parse debug flag
    if (
      "debug" in inputOptionsObj &&
      typeof inputOptionsObj["debug"] === "boolean"
    ) {
      options.debug = inputOptionsObj["debug"];
    }

    // Parse chime volume
    if (
      "chimeVolume" in inputOptionsObj &&
      typeof inputOptionsObj["chimeVolume"] === "number" &&
      inputOptionsObj["chimeVolume"] >= 0 &&
      inputOptionsObj["chimeVolume"] <= 1
    ) {
      options.chimeVolume = inputOptionsObj["chimeVolume"];
    } else if ("chimeVolume" in inputOptionsObj) {
      logger.warn("chimeVolume must be a number between 0.0 and 1.0");
    }

    // Parse MCP servers (throw errors for invalid MCP servers in main config)
    options.mcpServers = parseMCPServers(inputOptionsObj["mcpServers"], logger);

    if ("customCommands" in inputOptionsObj) {
      options.customCommands = parseCustomCommands(
        inputOptionsObj["customCommands"],
        logger,
      );
    }

    if (
      "editPrediction" in inputOptionsObj &&
      typeof inputOptionsObj["editPrediction"] === "object" &&
      inputOptionsObj["editPrediction"] !== null
    ) {
      const editPrediction = inputOptionsObj["editPrediction"] as Record<
        string,
        unknown
      >;
      options.editPrediction = {};

      // Parse changeTrackerMaxChanges
      if (
        "changeTrackerMaxChanges" in editPrediction &&
        typeof editPrediction["changeTrackerMaxChanges"] === "number" &&
        editPrediction["changeTrackerMaxChanges"] > 0
      ) {
        options.editPrediction.changeTrackerMaxChanges =
          editPrediction["changeTrackerMaxChanges"];
      }

      // Parse recentChangeTokenBudget
      if (
        "recentChangeTokenBudget" in editPrediction &&
        typeof editPrediction["recentChangeTokenBudget"] === "number" &&
        editPrediction["recentChangeTokenBudget"] > 0
      ) {
        options.editPrediction.recentChangeTokenBudget =
          editPrediction["recentChangeTokenBudget"];
      }

      // Parse systemPrompt
      if (
        "systemPrompt" in editPrediction &&
        typeof editPrediction["systemPrompt"] === "string" &&
        editPrediction["systemPrompt"].trim() !== ""
      ) {
        options.editPrediction.systemPrompt = editPrediction["systemPrompt"];
      }

      // Parse systemPromptAppend
      if (
        "systemPromptAppend" in editPrediction &&
        typeof editPrediction["systemPromptAppend"] === "string" &&
        editPrediction["systemPromptAppend"].trim() !== ""
      ) {
        options.editPrediction.systemPromptAppend =
          editPrediction["systemPromptAppend"];
      }

      // Parse profile
      if ("profile" in editPrediction) {
        const profile = parseEditPredictionProfile(
          editPrediction["profile"],
          logger,
        );
        if (profile) {
          options.editPrediction.profile = profile;
        }
      }
    }

    // Parse PKB options
    if (
      "pkb" in inputOptionsObj &&
      typeof inputOptionsObj["pkb"] === "object" &&
      inputOptionsObj["pkb"] !== null
    ) {
      const pkbInput = inputOptionsObj["pkb"] as Record<string, unknown>;
      const pkbOptions = parsePKBOptions(pkbInput, logger);
      if (pkbOptions) {
        options.pkb = pkbOptions;
      }
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
    inputOptionsObj["sidebarPosition"],
    logger,
  );
  if (sidebarPosition) {
    options.sidebarPosition = sidebarPosition;
  }

  // Parse command config
  if ("commandConfig" in inputOptionsObj) {
    const commandConfig = parseCommandConfig(
      inputOptionsObj["commandConfig"],
      logger,
    );
    if (commandConfig) {
      options.commandConfig = commandConfig;
    }
  }

  // Parse profiles
  if ("profiles" in inputOptionsObj) {
    const profiles = parseProfiles(inputOptionsObj["profiles"], logger);
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
    if (typeof inputOptionsObj["activeProfile"] === "string") {
      options.activeProfile = inputOptionsObj["activeProfile"];
    } else {
      logger.warn("activeProfile must be a string");
    }
  }

  // Parse auto context
  if ("autoContext" in inputOptionsObj) {
    options.autoContext = parseStringArray(
      inputOptionsObj["autoContext"],
      "autoContext",
      logger,
    );
  }

  // Parse skills paths
  if ("skillsPaths" in inputOptionsObj) {
    options.skillsPaths = parseStringArray(
      inputOptionsObj["skillsPaths"],
      "skillsPaths",
      logger,
    );
  }

  // Parse getFile auto allow globs
  if ("getFileAutoAllowGlobs" in inputOptionsObj) {
    options.getFileAutoAllowGlobs = parseStringArray(
      inputOptionsObj["getFileAutoAllowGlobs"],
      "getFileAutoAllowGlobs",
      logger,
    );
  }

  // Parse max concurrent subagents
  if (
    "maxConcurrentSubagents" in inputOptionsObj &&
    typeof inputOptionsObj["maxConcurrentSubagents"] === "number" &&
    inputOptionsObj["maxConcurrentSubagents"] > 0
  ) {
    options.maxConcurrentSubagents = inputOptionsObj["maxConcurrentSubagents"];
  }

  // Parse LSP debounce ms
  if (
    "lspDebounceMs" in inputOptionsObj &&
    typeof inputOptionsObj["lspDebounceMs"] === "number" &&
    inputOptionsObj["lspDebounceMs"] > 0
  ) {
    options.lspDebounceMs = inputOptionsObj["lspDebounceMs"];
  }

  // Parse debug flag
  if (
    "debug" in inputOptionsObj &&
    typeof inputOptionsObj["debug"] === "boolean"
  ) {
    options.debug = inputOptionsObj["debug"];
  }

  if (
    "chimeVolume" in inputOptionsObj &&
    typeof inputOptionsObj["chimeVolume"] === "number" &&
    inputOptionsObj["chimeVolume"] >= 0 &&
    inputOptionsObj["chimeVolume"] <= 1
  ) {
    options.chimeVolume = inputOptionsObj["chimeVolume"];
  } else if ("chimeVolume" in inputOptionsObj) {
    logger.warn("chimeVolume must be a number between 0.0 and 1.0");
  }

  // Parse MCP servers
  if ("mcpServers" in inputOptionsObj) {
    options.mcpServers = parseMCPServers(inputOptionsObj["mcpServers"], logger);
  }

  if ("customCommands" in inputOptionsObj) {
    options.customCommands = parseCustomCommands(
      inputOptionsObj["customCommands"],
      logger,
    );
  }

  if (
    "editPrediction" in inputOptionsObj &&
    typeof inputOptionsObj["editPrediction"] === "object" &&
    inputOptionsObj["editPrediction"] !== null
  ) {
    const editPrediction = inputOptionsObj["editPrediction"] as Record<
      string,
      unknown
    >;
    options.editPrediction = {};

    // Parse changeTrackerMaxChanges
    if (
      "changeTrackerMaxChanges" in editPrediction &&
      typeof editPrediction["changeTrackerMaxChanges"] === "number" &&
      editPrediction["changeTrackerMaxChanges"] > 0
    ) {
      options.editPrediction.changeTrackerMaxChanges =
        editPrediction["changeTrackerMaxChanges"];
    }

    // Parse recentChangeTokenBudget
    if (
      "recentChangeTokenBudget" in editPrediction &&
      typeof editPrediction["recentChangeTokenBudget"] === "number" &&
      editPrediction["recentChangeTokenBudget"] > 0
    ) {
      options.editPrediction.recentChangeTokenBudget =
        editPrediction["recentChangeTokenBudget"];
    }

    // Parse systemPrompt
    if (
      "systemPrompt" in editPrediction &&
      typeof editPrediction["systemPrompt"] === "string" &&
      editPrediction["systemPrompt"].trim() !== ""
    ) {
      options.editPrediction.systemPrompt = editPrediction["systemPrompt"];
    }

    // Parse systemPromptAppend
    if (
      "systemPromptAppend" in editPrediction &&
      typeof editPrediction["systemPromptAppend"] === "string" &&
      editPrediction["systemPromptAppend"].trim() !== ""
    ) {
      options.editPrediction.systemPromptAppend =
        editPrediction["systemPromptAppend"];
    }

    // Parse profile
    if ("profile" in editPrediction) {
      const profile = parseEditPredictionProfile(
        editPrediction["profile"],
        logger,
      );
      if (profile) {
        options.editPrediction.profile = profile;
      }
    }
  }

  return options;
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

      return parseProjectOptions(rawSettings, logger);
    }
  } catch (error) {
    logger.warn(
      `Failed to parse project settings at ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return undefined;
}

/** Merge two CommandPermissions objects - combines both command lists */
function mergeCommandConfig(
  base: CommandPermissions,
  project: CommandPermissions,
): CommandPermissions {
  return {
    commands: [...base.commands, ...project.commands],
    pipeCommands: [...base.pipeCommands, ...project.pipeCommands],
  };
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

  // Deep merge commandConfig - command is allowed if it matches either config
  if (projectSettings.commandConfig) {
    merged.commandConfig = mergeCommandConfig(
      baseOptions.commandConfig,
      projectSettings.commandConfig,
    );
  }

  if (projectSettings.autoContext) {
    merged.autoContext = [
      ...baseOptions.autoContext,
      ...projectSettings.autoContext,
    ];
  }

  if (projectSettings.skillsPaths) {
    merged.skillsPaths = [
      ...baseOptions.skillsPaths,
      ...projectSettings.skillsPaths,
    ];
  }

  if (projectSettings.getFileAutoAllowGlobs) {
    merged.getFileAutoAllowGlobs = [
      ...baseOptions.getFileAutoAllowGlobs,
      ...projectSettings.getFileAutoAllowGlobs,
    ];
  }

  if (projectSettings.sidebarPosition !== undefined) {
    merged.sidebarPosition = projectSettings.sidebarPosition;
  }

  if (projectSettings.maxConcurrentSubagents !== undefined) {
    merged.maxConcurrentSubagents = projectSettings.maxConcurrentSubagents;
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

  // Merge structured edit prediction options
  if (projectSettings.editPrediction) {
    merged.editPrediction = {
      ...merged.editPrediction,
      ...projectSettings.editPrediction,
    };
  }

  return merged;
}

export function getActiveProfile(profiles: Profile[], activeProfile: string) {
  const profile = profiles.find((p) => p.name == activeProfile);
  if (!profile) {
    throw new Error(`Profile ${activeProfile} not found.`);
  }
  return profile;
}
