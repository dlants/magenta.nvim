import { loadAgents } from "../agents/agents.ts";
import type { FileIO } from "../capabilities/file-io.ts";
import { formatGitInfo, type GitState } from "../capabilities/git-client.ts";
import type { SubagentConfig, ThreadType } from "../chat-types.ts";
import type { Logger } from "../logger.ts";
import type { ProviderOptions } from "../provider-options.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import {
  formatSkillsIntroduction,
  loadSkills,
  type SkillsMap,
} from "./skills.ts";

export type SystemPrompt = string & { __systemPrompt: true };

export interface SystemInfo {
  timestamp: string;
  platform: string;
  neovimVersion: string;
  cwd: NvimCwd;
  git?: GitState | undefined;
}

export const COMPACT_SYSTEM_PROMPT =
  "You are a compaction agent that reduces conversation transcripts using the edl tool. You MUST write your summary to the `/summary.md` file using the edl tool. Do NOT place the summary in your text response — only the contents of `/summary.md` are captured.";

function getBaseSystemPrompt(
  type: ThreadType,
  opts: {
    subagentConfig?: SubagentConfig | undefined;
    logger: Logger;
    cwd: NvimCwd;
    options: ProviderOptions;
  },
): { systemPrompt: string; systemReminder: string | undefined } {
  if (type === "compact") {
    return { systemPrompt: COMPACT_SYSTEM_PROMPT, systemReminder: undefined };
  }

  if (opts.subagentConfig?.systemPrompt) {
    return {
      systemPrompt: opts.subagentConfig.systemPrompt,
      systemReminder: opts.subagentConfig.systemReminder,
    };
  }

  // Fall back to loading agents from disk
  const agentName =
    type === "root"
      ? "default"
      : type === "docker_root"
        ? "docker"
        : "subagent";

  const agents = loadAgents({
    cwd: opts.cwd,
    logger: opts.logger,
    options: opts.options,
  });
  const agent = agents[agentName];
  if (agent) {
    return {
      systemPrompt: agent.systemPrompt,
      systemReminder: agent.systemReminder,
    };
  }

  return {
    systemPrompt: "You are a helpful coding assistant.",
    systemReminder: undefined,
  };
}

export async function createSystemPrompt(
  type: ThreadType,
  context: {
    logger: Logger;
    cwd: NvimCwd;
    options: ProviderOptions;
    fileIO: FileIO;
    homeDir: HomeDir;
    dockerAvailable?: boolean;
    subagentConfig?: SubagentConfig;
  },
): Promise<SystemPrompt> {
  const { systemPrompt: basePrompt, systemReminder } = getBaseSystemPrompt(
    type,
    {
      subagentConfig: context.subagentConfig,
      logger: context.logger,
      cwd: context.cwd,
      options: context.options,
    },
  );
  const skills =
    type === "compact" ? ({} as SkillsMap) : await loadSkills(context);

  const skillsText = formatSkillsIntroduction(skills);

  const reminderText = systemReminder
    ? `\n<system_reminder>\n${systemReminder}\n</system_reminder>`
    : "";

  return (basePrompt + skillsText + reminderText) as SystemPrompt;
}

// The system info (timestamp, cwd, git state) is volatile and would bust the
// cached system-prompt + tools prefix if included in the system prompt. Instead
// we prepend it to the first user message of a thread so the system prefix stays
// byte-identical across threads.
export function formatSystemInfo(systemInfo: SystemInfo): string {
  return `<system-info>
# System Information
- Current time: ${systemInfo.timestamp}
- Operating system: ${systemInfo.platform}
- Neovim version: ${systemInfo.neovimVersion}
- Current working directory: ${systemInfo.cwd}
${formatGitInfo(systemInfo.git)}
</system-info>`;
}
