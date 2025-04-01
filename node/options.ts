import { PROVIDER_NAMES, type ProviderName } from "./providers/provider";

export type MagentaOptions = {
  provider: ProviderName;
  openai: { model: string; omitParallelToolCalls?: boolean };
  anthropic: { model: string };
  bedrock: { model: string; promptCaching: boolean };
  sidebarPosition: "left" | "right";
};

export const DEFAULT_OPTIONS: MagentaOptions = {
  provider: "anthropic",
  anthropic: {
    model: "claude-3-7-sonnet-latest",
  },
  openai: {
    model: "gpt-4o",
  },
  bedrock: {
    model: "anthropic.claude-3-7-sonnet-20241022-v2:0",
    promptCaching: false,
  },
  sidebarPosition: "left",
};

export function parseOptions(inputOptions: unknown): MagentaOptions {
  const options = JSON.parse(JSON.stringify(DEFAULT_OPTIONS)) as MagentaOptions;

  if (typeof inputOptions == "object" && inputOptions != null) {
    const inputOptionsObj = inputOptions as { [key: string]: unknown };
    const sidebarPosition = inputOptionsObj["sidebar_position"];
    if (sidebarPosition === "right" || sidebarPosition === "left") {
      options.sidebarPosition = sidebarPosition;
    }
    if (
      typeof inputOptionsObj["provider"] == "string" &&
      PROVIDER_NAMES.indexOf(inputOptionsObj["provider"] as ProviderName) != -1
    ) {
      options.provider = inputOptionsObj.provider as ProviderName;
    }

    if (typeof inputOptionsObj["anthropic"] == "object") {
      const anthropicOptions = inputOptionsObj["anthropic"] as {
        [key: string]: unknown;
      };
      if (typeof anthropicOptions["model"] == "string") {
        options.anthropic.model = anthropicOptions.model;
      }
    }

    if (typeof inputOptionsObj["openai"] == "object") {
      const openaiOptions = inputOptionsObj["openai"] as {
        [key: string]: unknown;
      };
      if (typeof openaiOptions["model"] == "string") {
        options.openai.model = openaiOptions.model;
      }
      if (typeof openaiOptions["omitParallelToolCalls"] == "boolean") {
        options.openai.omitParallelToolCalls =
          openaiOptions.omitParallelToolCalls;
      }
    }

    if (typeof inputOptionsObj["bedrock"] == "object") {
      const bedrockOptions = inputOptionsObj["bedrock"] as {
        [key: string]: unknown;
      };
      if (typeof bedrockOptions["model"] == "string") {
        options.bedrock.model = bedrockOptions.model;
      }
      if (typeof bedrockOptions["prompt_caching"] == "boolean") {
        options.bedrock.promptCaching = bedrockOptions.prompt_caching;
      }
    }
  }

  return options;
}
