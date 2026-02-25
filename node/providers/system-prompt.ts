import {
  AGENT_TYPES,
  createSystemPrompt as coreCreateSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
  EXPLORE_SUBAGENT_SYSTEM_PROMPT,
  COMPACT_SYSTEM_PROMPT,
  type SystemPrompt,
  type NvimCwd,
  type ProviderOptions,
} from "@magenta/core";
import type { ThreadType } from "../chat/types.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { platform } from "os";

export {
  AGENT_TYPES,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SUBAGENT_SYSTEM_PROMPT,
  EXPLORE_SUBAGENT_SYSTEM_PROMPT,
  COMPACT_SYSTEM_PROMPT,
};

export type { AgentType, SystemPrompt, SystemInfo } from "@magenta/core";

export async function createSystemPrompt(
  type: ThreadType,
  context: {
    nvim: Nvim;
    cwd: NvimCwd;
    options: ProviderOptions;
  },
): Promise<SystemPrompt> {
  const neovimVersion = (await context.nvim.call("nvim_eval", [
    "v:version",
  ])) as string;

  return coreCreateSystemPrompt(type, {
    systemInfo: {
      timestamp: new Date().toString(),
      platform: platform(),
      neovimVersion,
      cwd: context.cwd,
    },
    logger: context.nvim.logger,
    cwd: context.cwd,
    options: context.options,
  });
}
