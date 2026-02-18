import type { ThreadType } from "../chat/types";
import { assertUnreachable } from "../utils/assertUnreachable";
import type { Nvim } from "../nvim/nvim-node";
import type { NvimCwd } from "../utils/files";
import { platform } from "os";
import type { MagentaOptions } from "../options";
import { loadSkills, formatSkillsIntroduction, type SkillsMap } from "./skills";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

export const AGENT_TYPES = ["default", "fast", "explore"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export type SystemPrompt = string & { __systemPrompt: true };

export interface SystemInfo {
  timestamp: string;
  platform: string;
  neovimVersion: string;
  cwd: NvimCwd;
}

async function getSystemInfo(nvim: Nvim, cwd: NvimCwd): Promise<SystemInfo> {
  const neovimVersion = (await nvim.call("nvim_eval", ["v:version"])) as string;

  return {
    timestamp: new Date().toString(),
    platform: platform(),
    neovimVersion,
    cwd: cwd,
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROMPTS_DIR = path.join(__dirname, "prompts");

function loadPrompt(filename: string): string {
  return readFileSync(path.join(PROMPTS_DIR, filename), "utf8");
}

export const DEFAULT_SYSTEM_PROMPT =
  loadPrompt("default-system-prompt.md") +
  "\n\n" +
  loadPrompt("codebase-conventions.md") +
  "\n" +
  loadPrompt("code-changes.md") +
  "\n" +
  loadPrompt("system-reminder.md");

export const DEFAULT_SUBAGENT_SYSTEM_PROMPT =
  loadPrompt("subagent-common.md") +
  "\n" +
  loadPrompt("codebase-conventions.md") +
  "\n" +
  loadPrompt("code-changes.md");

export const EXPLORE_SUBAGENT_SYSTEM_PROMPT = loadPrompt("explore-subagent.md");
export const COMPACT_SYSTEM_PROMPT =
  "You are a compaction agent that reduces conversation transcripts using the edl tool.";

function getBaseSystemPrompt(type: ThreadType): string {
  switch (type) {
    case "subagent_default":
      return DEFAULT_SUBAGENT_SYSTEM_PROMPT;
    case "subagent_fast":
      return DEFAULT_SUBAGENT_SYSTEM_PROMPT;
    case "subagent_explore":
      return EXPLORE_SUBAGENT_SYSTEM_PROMPT;
    case "compact":
      return COMPACT_SYSTEM_PROMPT;
    case "root":
      return DEFAULT_SYSTEM_PROMPT;
    default:
      assertUnreachable(type);
  }
}

export async function createSystemPrompt(
  type: ThreadType,
  context: {
    nvim: Nvim;
    cwd: NvimCwd;
    options: MagentaOptions;
  },
): Promise<SystemPrompt> {
  const basePrompt = getBaseSystemPrompt(type);
  const skills = type === "compact" ? ({} as SkillsMap) : loadSkills(context);
  const systemInfo = await getSystemInfo(context.nvim, context.cwd);

  const systemInfoText = `

# System Information
- Current time: ${systemInfo.timestamp}
- Operating system: ${systemInfo.platform}
- Neovim version: ${systemInfo.neovimVersion}
- Current working directory: ${systemInfo.cwd}`;

  const skillsText = formatSkillsIntroduction(skills, context.cwd);

  return (basePrompt + systemInfoText + skillsText) as SystemPrompt;
}
