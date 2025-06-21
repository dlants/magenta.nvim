import { PROVIDER_NAMES, type ProviderName } from "./providers/provider";
import * as fs from "fs";
import * as path from "path";
import type { ServerName } from "./tools/mcp/types";

export type Profile = {
  name: string;
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  apiKeyEnvVar?: string;
  promptCaching?: boolean; // Primarily used by Bedrock provider
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
      type: "mock";
      tools?: MCPMockToolConfig[];
    };

export type MagentaOptions = {
  profiles: Profile[];
  activeProfile: string;
  sidebarPosition: "left" | "right";
  commandAllowlist: CommandAllowlist;
  autoContext: string[];
  mcpServers: { [serverName: ServerName]: MCPServerConfig };
};

// Reusable parsing helpers
function parseProfiles(
  profilesInput: unknown,
  logger?: { warn: (msg: string) => void },
): Profile[] {
  if (!Array.isArray(profilesInput)) {
    logger?.warn("profiles must be an array");
    return [];
  }

  const profiles: Profile[] = [];

  for (const profile of profilesInput) {
    try {
      if (typeof profile !== "object" || profile === null) {
        logger?.warn(`Skipping invalid profile: ${JSON.stringify(profile)}`);
        continue;
      }

      const p = profile as { [key: string]: unknown };

      if (
        !(
          typeof p["name"] === "string" &&
          typeof p["provider"] === "string" &&
          PROVIDER_NAMES.indexOf(p["provider"] as ProviderName) !== -1 &&
          typeof p["model"] === "string"
        )
      ) {
        logger?.warn(
          `Skipping profile with missing required fields: ${JSON.stringify(p)}`,
        );
        continue;
      }

      const out: Profile = {
        name: p["name"],
        provider: p["provider"] as ProviderName,
        model: p["model"],
      };

      if ("base_url" in p) {
        if (typeof p["base_url"] === "string") {
          out.baseUrl = p["base_url"];
        } else {
          logger?.warn(
            `Invalid base_url in profile ${p["name"]}, ignoring field`,
          );
        }
      }

      if ("apiKeyEnvVar" in p) {
        if (typeof p["apiKeyEnvVar"] === "string") {
          out.apiKeyEnvVar = p["apiKeyEnvVar"];
        } else {
          logger?.warn(
            `Invalid apiKeyEnvVar in profile ${p["name"]}, ignoring field`,
          );
        }
      }

      if ("promptCaching" in p) {
        if (typeof p["promptCaching"] === "boolean") {
          out.promptCaching = p["promptCaching"];
        } else {
          logger?.warn(
            `Invalid promptCaching in profile ${p["name"]}, ignoring field`,
          );
        }
      }

      profiles.push(out);
    } catch (error) {
      logger?.warn(
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
  logger?: { warn: (msg: string) => void },
): Record<string, MCPServerConfig> {
  if (!input) {
    return {};
  }

  if (typeof input !== "object") {
    logger?.warn("mcpServers must be an object");
    return {};
  }

  const servers: Record<string, MCPServerConfig> = {};
  const inputObj = input as Record<string, unknown>;

  for (const [serverName, serverConfig] of Object.entries(inputObj)) {
    try {
      if (typeof serverConfig !== "object" || serverConfig === null) {
        logger?.warn(
          `Skipping invalid MCP server config for ${serverName}: must be an object`,
        );
        continue;
      }

      const config = serverConfig as Record<string, unknown>;

      if (config["type"] == "mock") {
        const mockConfig: MCPServerConfig = { type: "mock" };
        if (config.tools && Array.isArray(config.tools)) {
          mockConfig.tools = config.tools as MCPMockToolConfig[];
        }
        servers[serverName] = mockConfig;
        continue;
      }

      if (typeof config.command !== "string") {
        logger?.warn(
          `Skipping MCP server ${serverName}: command must be a string`,
        );
        continue;
      }

      if (!Array.isArray(config.args)) {
        logger?.warn(
          `Skipping MCP server ${serverName}: args must be an array`,
        );
        continue;
      }

      const args = config.args.filter((arg) => {
        if (typeof arg === "string") {
          return true;
        } else {
          logger?.warn(
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
              logger?.warn(
                `Skipping non-string env value in MCP server ${serverName}: ${envKey}=${JSON.stringify(envValue)}`,
              );
            }
          }

          if (Object.keys(env).length > 0) {
            serverConfigOut.env = env;
          }
        } else {
          logger?.warn(
            `Invalid env in MCP server ${serverName}: must be an object`,
          );
        }
      }

      servers[serverName] = serverConfigOut;
    } catch (error) {
      logger?.warn(
        `Error parsing MCP server ${serverName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return servers;
}

function parseSidebarPosition(
  input: unknown,
  logger?: { warn: (msg: string) => void },
): "left" | "right" | undefined {
  if (input === "right" || input === "left") {
    return input;
  } else if (input !== undefined) {
    logger?.warn(
      `Invalid sidebarPosition: ${JSON.stringify(input)}, must be "left" or "right"`,
    );
  }
  return undefined;
}

export function parseOptions(
  inputOptions: unknown,
  logger: { warn: (msg: string) => void },
): MagentaOptions {
  const options: MagentaOptions = {
    profiles: [],
    activeProfile: "",
    sidebarPosition: "left",
    commandAllowlist: [],
    autoContext: [],
    mcpServers: {},
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

    // Parse MCP servers (throw errors for invalid MCP servers in main config)
    options.mcpServers = parseMCPServers(inputOptionsObj["mcpServers"], logger);
  }

  return options;
}

export function parseProjectOptions(
  inputOptions: unknown,
  logger?: { warn: (msg: string) => void },
): Partial<MagentaOptions> {
  const options: Partial<MagentaOptions> = {};

  if (typeof inputOptions !== "object" || inputOptions === null) {
    logger?.warn("Project options must be an object");
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
      logger?.warn("activeProfile must be a string");
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

  // Parse MCP servers
  if ("mcpServers" in inputOptionsObj) {
    options.mcpServers = parseMCPServers(inputOptionsObj["mcpServers"], logger);
  }

  return options;
}

export function loadProjectSettings(
  cwd: string,
  logger?: { warn: (msg: string) => void },
): Partial<MagentaOptions> | undefined {
  const settingsPath = path.join(cwd, ".magenta", "options.json");

  try {
    if (fs.existsSync(settingsPath)) {
      const fileContent = fs.readFileSync(settingsPath, "utf8");
      const rawSettings = JSON.parse(fileContent) as unknown;

      return parseProjectOptions(rawSettings, logger);
    }
  } catch (error) {
    logger?.warn(
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

  if (projectSettings.sidebarPosition !== undefined) {
    merged.sidebarPosition = projectSettings.sidebarPosition;
  }

  if (projectSettings.mcpServers) {
    merged.mcpServers = {
      ...baseOptions.mcpServers,
      ...projectSettings.mcpServers,
    };
  }

  return merged;
}
