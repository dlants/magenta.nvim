import type { ThreadType } from "../chat/types.ts";
import { assertUnreachable } from "../utils/assertUnreachable.ts";
import type { Logger } from "../logger.ts";
import type { Cwd } from "../utils/files.ts";
import { platform } from "os";
import type { MagentaOptions } from "../options.ts";
import { loadSkills, formatSkillsIntroduction } from "./skills.ts";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

export const AGENT_TYPES = ["default", "fast", "explore"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export type SystemPrompt = string & { __systemPrompt: true };

export interface SystemInfo {
  timestamp: string;
  platform: string;
  cwd?: Cwd;
  clientInfo?: string;
}

function getSystemInfo(cwd: Cwd | undefined): SystemInfo {
  return {
    timestamp: new Date().toString(),
    platform: platform(),
    ...(cwd ? { cwd } : {}),
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

function getBaseSystemPrompt(type: ThreadType): string {
  switch (type) {
    case "subagent_default":
      return DEFAULT_SUBAGENT_SYSTEM_PROMPT;
    case "subagent_fast":
      return DEFAULT_SUBAGENT_SYSTEM_PROMPT;
    case "subagent_explore":
      return EXPLORE_SUBAGENT_SYSTEM_PROMPT;
    case "root":
      return DEFAULT_SYSTEM_PROMPT;
    default:
      assertUnreachable(type);
  }
}

export function createSystemPrompt(
  type: ThreadType,
  context: {
    logger: Logger;
    cwd?: Cwd;
    options: MagentaOptions;
    clientInfo?: string;
  },
): SystemPrompt {
  const basePrompt = getBaseSystemPrompt(type);
  const skills = loadSkills(context);
  const systemInfo = getSystemInfo(context.cwd);

  let systemInfoText = `

# System Information
- Current time: ${systemInfo.timestamp}
- Operating system: ${systemInfo.platform}`;

  if (systemInfo.cwd) {
    systemInfoText += `
- Current working directory: ${systemInfo.cwd}`;
  }

  if (context.clientInfo) {
    systemInfoText += `\n- Client: ${context.clientInfo}`;
  }

  const skillsText = formatSkillsIntroduction(skills, context.cwd);

  return (basePrompt + systemInfoText + skillsText) as SystemPrompt;
}
