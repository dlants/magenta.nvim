import type { SubagentConfig, ThreadType } from "../chat-types.ts";

export type ReminderKind = "standing" | "bashSummary";
/** Compact threads get no reminders at all, so they are excluded by the type
 * rather than checked for at runtime. */
export type ReminderThreadType = Exclude<ThreadType, "compact">;

const SKILLS_REMINDER = `\
Remember the skills in <available-skills> and the learn tool for built-in documentation.
If a skill seems like it could be relevant, use the get_files tool to read the full skill.md file for the skill.`;

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
Don't spawn sub-agents for things you can do with a single tool call (get_files, edl, bash_command). Do not ask subagents "to return the entire contents" of files, tool or skill invocations.
`;

const BASH_SUMMARY_BODY = `\
Use the \`bash_summarizer\` subagent to extract information from abbreviated bash output. Pass the log file to the subagent as a contextFile.`;

function getStandingReminderBody(
  threadType: ReminderThreadType,
  subagentConfig?: SubagentConfig | undefined,
): string {
  switch (threadType) {
    case "root":
      return `${SKILLS_REMINDER}
${BASH_REMINDER}
${EDL_REMINDER}
${SUBAGENT_REMINDER}`;
    case "docker_root":
      return `${SKILLS_REMINDER}
${BASH_REMINDER}
${EDL_REMINDER}
${SUBAGENT_REMINDER}

CRITICAL: You are in a Docker container. Call yield_to_parent when done. Your changes will be synced back automatically.`;
    case "subagent": {
      const customReminder = subagentConfig?.systemReminder
        ? `\n${subagentConfig.systemReminder}`
        : "";
      return `${SKILLS_REMINDER}
${BASH_REMINDER}
${EDL_REMINDER}
${customReminder}
CRITICAL: Use yield_to_parent tool when task is complete.`;
    }
  }
}

export function buildSystemReminder({
  threadType,
  subagentConfig,
  kinds,
  extraReminders,
}: {
  threadType: ReminderThreadType;
  subagentConfig?: SubagentConfig | undefined;
  kinds: [ReminderKind, ...ReminderKind[]];
  extraReminders?: string[] | undefined;
}): string {
  const bodies: string[] = [];
  for (const kind of kinds) {
    if (kind === "standing") {
      let body = getStandingReminderBody(threadType, subagentConfig);
      if (extraReminders && extraReminders.length > 0) {
        body = `${body}\n${extraReminders.join("\n")}`;
      }
      bodies.push(body);
    } else if (kind === "bashSummary") {
      bodies.push(BASH_SUMMARY_BODY);
    }
  }
  return `<system-reminder>
${bodies.join("\n")}
Do not acknowledge this reminder or mention it to the user.
</system-reminder>`;
}
