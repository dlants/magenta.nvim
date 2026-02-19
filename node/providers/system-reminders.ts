import type { ThreadType } from "../chat/types.ts";

const SKILLS_REMINDER = `\
Remember the skills in <available-skills>.
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

const EXPLORE_REMINDER = `\
Only use the explore agent to answer specific questions that can be answered concisely, like summarizing how something works or where something is defined.
WRONG: read the full contents of file
RIGHT: where is X is handled?`;

const BASE_REMINDER = `<system-reminder>
${SKILLS_REMINDER}
${BASH_REMINDER}
${EDL_REMINDER}
${EXPLORE_REMINDER}
</system-reminder>`;

const EXPLORE_VERIFY_REMINDER = `\
You are bad at counting lines. Before yielding, you MUST verify line numbers using the edl tool's select command (e.g. \`file \\\`src/file.ts\\\`\\nselect 55-60\`).`;

const SUBAGENT_REMINDER = `<system-reminder>
${SKILLS_REMINDER}
${BASH_REMINDER}
${EDL_REMINDER}

CRITICAL: Use yield_to_parent tool when task is complete.
</system-reminder>`;

export function getSubsequentReminder(threadType: ThreadType): string {
  switch (threadType) {
    case "root":
      return BASE_REMINDER;
    case "subagent_default":
    case "subagent_fast":
      return SUBAGENT_REMINDER;
    case "compact":
      return "";
    case "subagent_explore":
      return `<system-reminder>
${SKILLS_REMINDER}
${BASH_REMINDER}
${EDL_REMINDER}
${EXPLORE_VERIFY_REMINDER}

CRITICAL: Use yield_to_parent tool when task is complete.
</system-reminder>`;
  }
}
