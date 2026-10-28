import { platform } from "node:os";
import type { SystemInfo } from "../providers/system-prompt.ts";
import type { ProjectDir } from "../utils/files.ts";

export function buildSystemInfo(ctx: {
  projectDir: ProjectDir;
  neovimVersion: string;
  overrides?: Partial<SystemInfo>;
}): SystemInfo {
  return {
    timestamp: new Date().toString(),
    platform: platform(),
    neovimVersion: ctx.neovimVersion,
    projectDir: ctx.projectDir,
    ...ctx.overrides,
  };
}
