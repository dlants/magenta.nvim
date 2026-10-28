import { loadAgents } from "../agents/agents.ts";
import type { FileIO } from "../capabilities/file-io.ts";
import { formatGitInfo, type GitState } from "../capabilities/git-client.ts";
import type { SubagentConfig, ThreadType } from "../chat-types.ts";
import type { Logger } from "../logger.ts";
import type { ProviderOptions } from "../provider-options.ts";
import type { HomeDir, ProjectDir } from "../utils/files.ts";
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
  projectDir: ProjectDir;
  git?: GitState | undefined;
}

export const COMPACT_SYSTEM_PROMPT =
  "You are a compaction agent that reduces conversation transcripts using the edl tool. You MUST write your summary to the `/summary.md` file using the edl tool. Do NOT place the summary in your text response — only the contents of `/summary.md` are captured.";

export const REFLECT_SYSTEM_PROMPT = `You help the user understand what happened in a coding-agent conversation.

The first user message contains a <thread-context> block: a rendered transcript of another thread (a coding agent working with the user), abridged so that file contents and long tool outputs are omitted. After it, the user quotes a passage they selected from that transcript. The quote is copied from the editor's display of the thread, so it may include display decoration (headers, summaries of tool calls, collapsed placeholders) rather than exact message text.

Interpret the user's message in terms of that selection. Your job is to orient the user:
- Explain what the agent did at that point, and why, grounded in the transcript.
- Answer at the user's level. If it is unclear what they are missing, ask.
- Point out assumptions, risks or alternatives when they help understanding.

Do not continue the agent's task and do not modify any files. You may read files, run shell commands, hover or find references to explain things accurately.`;

function getBaseSystemPrompt(
  type: ThreadType,
  opts: {
    subagentConfig?: SubagentConfig | undefined;
    logger: Logger;
    projectDir: ProjectDir;
    options: ProviderOptions;
  },
): { systemPrompt: string; systemReminder: string | undefined } {
  if (type === "compact") {
    return { systemPrompt: COMPACT_SYSTEM_PROMPT, systemReminder: undefined };
  }

  if (type === "reflect") {
    return { systemPrompt: REFLECT_SYSTEM_PROMPT, systemReminder: undefined };
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
    projectDir: opts.projectDir,
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
    projectDir: ProjectDir;
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
      projectDir: context.projectDir,
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

// The system info (timestamp, projectDir, git state) is volatile and would bust the
// cached system-prompt + tools prefix if included in the system prompt. Instead
// we prepend it to the first user message of a thread so the system prefix stays
// byte-identical across threads.
export function formatSystemInfo(systemInfo: SystemInfo): string {
  return `<system-info>
# System Information
- Current time: ${systemInfo.timestamp}
- Operating system: ${systemInfo.platform}
- Neovim version: ${systemInfo.neovimVersion}
- The user started this thread from: ${systemInfo.projectDir}
- There is no working directory: bash commands start at \`/\` and file tools require absolute paths. Use absolute file paths in all tool calls and when showing paths to the user.
${formatGitInfo(systemInfo.git)}
</system-info>`;
}
