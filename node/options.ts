import { PROVIDER_NAMES, type ProviderName } from "./providers/provider";

export type Profile = {
  name: string;
  provider: ProviderName;
  model: string;
  baseUrl?: string;
  apiKeyEnvVar?: string;
  promptCaching?: boolean; // Primarily used by Bedrock provider
};

export type CommandAllowlist = string[];

export type MagentaOptions = {
  profiles: Profile[];
  activeProfile: string;
  sidebarPosition: "left" | "right";
  commandAllowlist: CommandAllowlist;
  autoContext: string[];
};

export function parseOptions(inputOptions: unknown): MagentaOptions {
  const options: MagentaOptions = {
    profiles: [],
    activeProfile: "",
    sidebarPosition: "left",
    commandAllowlist: [],
    autoContext: [],
  };

  if (typeof inputOptions == "object" && inputOptions != null) {
    const inputOptionsObj = inputOptions as { [key: string]: unknown };

    // Parse sidebar position
    const sidebarPosition = inputOptionsObj["sidebarPosition"];
    if (sidebarPosition === "right" || sidebarPosition === "left") {
      options.sidebarPosition = sidebarPosition;
    }

    if (Array.isArray(inputOptionsObj["commandAllowlist"])) {
      options.commandAllowlist = inputOptionsObj["commandAllowlist"].filter(
        (pattern) => typeof pattern === "string",
      );
    }

    if (Array.isArray(inputOptionsObj["profiles"])) {
      const optionProfiles = inputOptionsObj["profiles"] as unknown[];

      options.profiles = optionProfiles
        .map((profile): Profile | undefined => {
          if (typeof profile !== "object" || profile === null) return undefined;
          const p = profile as { [key: string]: unknown };

          if (
            !(
              typeof p["name"] === "string" &&
              typeof p["provider"] === "string" &&
              PROVIDER_NAMES.indexOf(p["provider"] as ProviderName) !== -1 &&
              typeof p["model"] === "string"
            )
          ) {
            throw new Error(
              `Invalid profile provided: ${JSON.stringify(p, null, 2)}`,
            );
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
              throw new Error(
                `Invalid profile - base_url must be a string: ${JSON.stringify(p, null, 2)}`,
              );
            }
          }

          if ("apiKeyEnvVar" in p) {
            if (typeof p["apiKeyEnvVar"] === "string") {
              out.apiKeyEnvVar = p["apiKeyEnvVar"];
            } else {
              throw new Error(
                `Invalid profile - api_key_env_var must be a string: ${JSON.stringify(p, null, 2)}`,
              );
            }
          }

          if ("promptCaching" in p) {
            if (typeof p["promptCaching"] === "boolean") {
              out.promptCaching = p["promptCaching"];
            } else {
              throw new Error(
                `Invalid profile - prompt_caching must be a boolean: ${JSON.stringify(p, null, 2)}`,
              );
            }
          }

          return out;
        })
        .filter((p) => p != undefined);
    }

    if (options.profiles.length == 0) {
      throw new Error(`Invalid profiles provided`);
    }
    options.activeProfile = options.profiles[0].name;

    if (Array.isArray(inputOptionsObj["autoContext"])) {
      options.autoContext = inputOptionsObj["autoContext"].filter(
        (pattern) => typeof pattern === "string",
      );
    }
  }

  return options;
}
