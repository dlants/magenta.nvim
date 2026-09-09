import { platform } from "node:os";
import {
  COMPACT_SYSTEM_PROMPT,
  createSystemPrompt as coreCreateSystemPrompt,
  type FileIO,
  type HomeDir,
  type NvimCwd,
  type ProviderOptions,
  type SubagentConfig,
  type SystemInfo,
  type SystemPrompt,
  type ThreadType,
} from "@magenta/server";
import type { Nvim } from "../nvim/nvim-node/index.ts";

export { COMPACT_SYSTEM_PROMPT };

export type { SystemInfo, SystemPrompt } from "@magenta/server";

export async function buildSystemInfo(context: {
  nvim: Nvim;
  cwd: NvimCwd;
  systemInfoOverrides?: Partial<SystemInfo>;
}): Promise<SystemInfo> {
  const neovimVersion = (await context.nvim.call("nvim_eval", [
    "v:version",
  ])) as string;

  return {
    timestamp: new Date().toString(),
    platform: platform(),
    neovimVersion,
    cwd: context.cwd,
    ...context.systemInfoOverrides,
  };
}

export async function createSystemPrompt(
  type: ThreadType,
  context: {
    nvim: Nvim;
    cwd: NvimCwd;
    options: ProviderOptions;
    fileIO: FileIO;
    homeDir: HomeDir;
    dockerAvailable?: boolean;
    subagentConfig?: SubagentConfig;
  },
): Promise<SystemPrompt> {
  return coreCreateSystemPrompt(type, {
    logger: context.nvim.logger,
    cwd: context.cwd,
    options: context.options,
    fileIO: context.fileIO,
    homeDir: context.homeDir,
    ...(context.dockerAvailable
      ? { dockerAvailable: context.dockerAvailable }
      : {}),
    ...(context.subagentConfig
      ? { subagentConfig: context.subagentConfig }
      : {}),
  });
}
