import type { SubagentConfig, ThreadType } from "../chat-types.ts";

const SKILLS_REMINDER = `\
Remember the skills in <available-skills> and the learn tool for built-in documentation.
If a skill seems like it could be relevant, use the get_file tool to read the full skill.md file for the skill.`;

const EDL_REMINDER = `\
Avoid using large portions of text when using the EDL tool. Large text blocks are fragile and wasteful.
When making a selection, select the beginning of the text, then extend_forward to the end. To move code around, use registers via cut.

Prefer text/regex patterns over line numbers for selection — line numbers are fragile and error-prone. Use heredoc patterns as the default since they match exactly.`;

const BASH_REMINDER = `\
When using bash_command, output is AUTOMATICALLY trimmed and saved. NEVER use head, tail, or 2>&1 - they break output handling.
WRONG: \`command 2>&1 | tail -50\`
WRONG: \`command | head -100\`
RIGHT: \`command\``;

const SUBAGENT_REMINDER = `\
Don't spawn sub-agents for things you can do with a single tool call (get_file, edl, bash_command). Do not ask subagents "to return the entire contents" of files, tool or skill invocations.
`;

const BASE_REMINDER = `<system-reminder>
${SKILLS_REMINDER}
${BASH_REMINDER}
${EDL_REMINDER}
${SUBAGENT_REMINDER}
</system-reminder>`;

export function getSubsequentReminder(
  threadType: ThreadType,
  subagentConfig?: SubagentConfig,
): string {
  switch (threadType) {
    case "root":
      return BASE_REMINDER;
    case "docker_root":
      return `<system-reminder>
${SKILLS_REMINDER}
${BASH_REMINDER}
${EDL_REMINDER}
${SUBAGENT_REMINDER}

CRITICAL: You are in a Docker container. Call yield_to_parent when done. Your changes will be synced back automatically.
</system-reminder>`;
    case "subagent": {
      const customReminder = subagentConfig?.systemReminder
        ? `\n${subagentConfig.systemReminder}`
        : "";
      return `<system-reminder>
${SKILLS_REMINDER}
${BASH_REMINDER}
${EDL_REMINDER}
${customReminder}
CRITICAL: Use yield_to_parent tool when task is complete.
</system-reminder>`;
    }
    case "compact":
      return `<system-reminder>
${EDL_REMINDER}
CRITICAL: You MUST write the summary to /summary.md using the edl tool.
</system-reminder>`;
  }
}

export function getBashSummaryReminder(
  threadType: ThreadType,
): string | undefined {
  if (threadType === "compact") {
    return undefined;
  }
  return `<system-reminder>
Use the \`bash_summarizer\` subagent to extract information from abbreviated bash output. Pass the log file to the subagent as a contextFile.
</system-reminder>`;
}
