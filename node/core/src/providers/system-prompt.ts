import type { ThreadType } from "../chat-types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Logger } from "../logger.ts";
import type { Cwd } from "../paths.ts";
import type { ProviderOptions } from "../provider-options.ts";
import {
  loadSkills,
  formatSkillsIntroduction,
  type SkillsMap,
} from "./skills.ts";
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
  cwd: Cwd;
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
  "You are a compaction agent that reduces conversation transcripts using the edl tool. You MUST write your summary to the `/summary.md` file using the edl tool. Do NOT place the summary in your text response — only the contents of `/summary.md` are captured.";

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

export function createSystemPrompt(
  type: ThreadType,
  context: {
    systemInfo: SystemInfo;
    logger: Logger;
    cwd: Cwd;
    options: ProviderOptions;
  },
): SystemPrompt {
  const basePrompt = getBaseSystemPrompt(type);
  const skills = type === "compact" ? ({} as SkillsMap) : loadSkills(context);
  const systemInfo = context.systemInfo;

  const systemInfoText = `

# System Information
- Current time: ${systemInfo.timestamp}
- Operating system: ${systemInfo.platform}
- Neovim version: ${systemInfo.neovimVersion}
- Current working directory: ${systemInfo.cwd}`;

  const skillsText = formatSkillsIntroduction(skills, systemInfo.cwd);

  return (basePrompt + systemInfoText + skillsText) as SystemPrompt;
}
