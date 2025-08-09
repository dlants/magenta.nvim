import { PROVIDER_NAMES, type ProviderName } from "./providers/provider";
import * as fs from "fs";
import * as path from "path";
import type { ServerName } from "./tools/mcp/types";
import { validateServerName } from "./tools/mcp/types";
import type { NvimCwd } from "./utils/files";

// Default models by provider
const DEFAULT_MODELS: Record<
  ProviderName,
  { model: string; fastModel: string }
> = {
  anthropic: {
    model: "claude-4-sonnet-latest",
    fastModel: "claude-3-5-haiku-latest",
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
    fastModel: "llama3.1:8b",
  },
  copilot: {
    model: "claude-3.7-sonnet",
    fastModel: "claude-3-5-haiku-latest",
  },
};

export type Profile = {
  name: string;
  provider: ProviderName;
  model: string;
  fastModel: string;
  baseUrl?: string;
  apiKeyEnvVar?: string;
  promptCaching?: boolean; // Primarily used by Bedrock provider
  thinking?: {
    enabled: boolean;
    budgetTokens?: number;
  };
  reasoning?: {
    effort?: "low" | "medium" | "high";
    summary?: "auto" | "concise" | "detailed";
  };
};

export type CommandAllowlist = string[];

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
  provider: ProviderName;
  model: string;
  baseUrl?: string | undefined;
  apiKeyEnvVar?: string | undefined;
};

export type EditPredictionOptions = {
  changeTrackerMaxChanges?: number;
  recentChangeTokenBudget?: number;
  systemPrompt?: string;
  systemPromptAppend?: string;
  profile?: EditPredictionProfile;
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

export type SidebarPositions = "left" | "right" | "below" | "above" | "tab" | "leftbelow" | "leftabove" | "rightbelow" | "rightabove"; 
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
  commandAllowlist: CommandAllowlist;
  autoContext: string[];
  maxConcurrentSubagents: number;
  mcpServers: { [serverName: ServerName]: MCPServerConfig };
  getFileAutoAllowGlobs: string[];
  lspDebounceMs?: number;
  debug?: boolean;
  // New structured options
  editPrediction?: EditPredictionOptions;
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

  return profile;
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

      const out: Profile = {
        name: p["name"],
        provider,
        model: typeof p["model"] === "string" ? p["model"] : defaults.model,
        fastModel:
          typeof p["fastModel"] === "string"
            ? p["fastModel"]
            : defaults.fastModel,
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

      if ("promptCaching" in p) {
        if (typeof p["promptCaching"] === "boolean") {
          out.promptCaching = p["promptCaching"];
        } else {
          logger.warn(
            `Invalid promptCaching in profile ${p["name"]}, ignoring field`,
          );
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

function parseSidebarPosition(
  input: unknown,
  logger?: { warn: (msg: string) => void },
): SidebarPositions | undefined {
  if (input === "right" || input === "left" || input == "above" || input == "below" || input == "tab" || 
      input === "leftbelow" || input === "leftabove" || input === "rightbelow" || input === "rightabove") {
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
          logger?.warn(`sidebarPositionOpts.${side} must have widthPercentage and displayHeightPercentage`);
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
          logger?.warn(`sidebarPositionOpts.${side} must have displayHeightPercentage and inputHeightPercentage`);
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
        logger?.warn("sidebarPositionOpts.tab must have displayHeightPercentage");
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

export function parseOptions(
  inputOptions: unknown,
  logger: { warn: (msg: string) => void, error: (msg: string) => void },
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
        widthPercentage: 0.3,
        displayHeightPercentage: 0.8,
      },
      right: {
        widthPercentage: 0.3,
        displayHeightPercentage: 0.8,
      }
    },
    maxConcurrentSubagents: 3,
    commandAllowlist: [],
    autoContext: [],
    mcpServers: {},
    getFileAutoAllowGlobs: [],
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

    // Parse command allowlist
    options.commandAllowlist = parseStringArray(
      inputOptionsObj["commandAllowlist"],
      "commandAllowlist",
    );

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

    // Parse MCP servers (throw errors for invalid MCP servers in main config)
    options.mcpServers = parseMCPServers(inputOptionsObj["mcpServers"], logger);

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

  // Parse command allowlist
  if ("commandAllowlist" in inputOptionsObj) {
    options.commandAllowlist = parseStringArray(
      inputOptionsObj["commandAllowlist"],
      "commandAllowlist",
      logger,
    );
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

  // Parse MCP servers
  if ("mcpServers" in inputOptionsObj) {
    options.mcpServers = parseMCPServers(inputOptionsObj["mcpServers"], logger);
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

export function mergeOptions(
  baseOptions: MagentaOptions,
  projectSettings: Partial<MagentaOptions>,
): MagentaOptions {
  const merged: MagentaOptions = { ...baseOptions };

  if (projectSettings.profiles && projectSettings.profiles.length > 0) {
    merged.profiles = projectSettings.profiles;
    merged.activeProfile = projectSettings.profiles[0].name;
  }

  if (projectSettings.commandAllowlist) {
    merged.commandAllowlist = [
      ...baseOptions.commandAllowlist,
      ...projectSettings.commandAllowlist,
    ];
  }

  if (projectSettings.autoContext) {
    merged.autoContext = [
      ...baseOptions.autoContext,
      ...projectSettings.autoContext,
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

  if (projectSettings.mcpServers) {
    merged.mcpServers = {
      ...baseOptions.mcpServers,
      ...projectSettings.mcpServers,
    };
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
