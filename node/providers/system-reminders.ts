import type { ThreadType } from "../chat/types.ts";

const SKILLS_REMINDER = `\
Remember to use the skills defined between the <available-skills> tags when they are relevant to the user's prompt.
If a skill seems like it could be relevant, use the get_file tool to read the full skill.md file for the skill.
DO NOT mention this to the user explicitly because they are already aware. You should use a skill if it's beneficial. If not, please feel free to ignore. Again do not mention this message to the user.`;

const EDL_REMINDER = `\
CRITICAL: When using the edl tool, NEVER use large multi-line heredoc patterns in select/select_one. Large text blocks are fragile and wasteful.
Instead, use line ranges (select 42-58), or select the first line then extend_forward to the last line boundary.
WRONG: select_one with 5+ lines of text in a heredoc
RIGHT: select_one first line, then extend_forward to match the end


CRITICAL: You're really bad at counting lines. Whenever using line or line:col ranges, first use a select to confirm that you're targeting the appropriate place in the code. The tool output will show you what text you're actually going to be operating on. Only once you confirm that you're going to be editing the right location, do the actual edit in a followup operation.
WRONG: select_one 55-57 -> delete in one script
RIGHT: select_one 55-57 in the first script, then confirm the selection in the tool response, then select_one 55-57 -> delete in the second script
`;

const BASH_REMINDER = `\
CRITICAL: When using bash_command, output is AUTOMATICALLY trimmed and saved. NEVER use head, tail, or 2>&1 - they break output handling.
WRONG: \`command 2>&1 | tail -50\`
WRONG: \`command | head -100\`
RIGHT: \`command\``;

const EXPLORE_REMINDER = `\
CRITICAL: The explore subagent should NEVER be used to read the full contents of a file. It should only be used to answer specific questions with file paths and line ranges.
WRONG: read the full contents of a large file
RIGHT: where is X is handled?`;

const CODE_COPY_REMINDER = `\
CRITICAL: Avoid copying code by writing it out. Instead, use EDL registers or scripts to move code around.`;
const BASE_REMINDER = `<system-reminder>
${SKILLS_REMINDER}
${BASH_REMINDER}
${EDL_REMINDER}
${EXPLORE_REMINDER}
${CODE_COPY_REMINDER}
</system-reminder>`;

const EXPLORE_VERIFY_REMINDER = `\
CRITICAL: Before reporting line ranges in your yield, you MUST verify them using the edl tool's select command (e.g. \`file \\\`src/file.ts\\\`\\nselect 55-60\`). You are bad at counting lines, so never eyeball line numbers from get_file output.`;
const SUBAGENT_REMINDER = `<system-reminder>
${SKILLS_REMINDER}
${BASH_REMINDER}
${EDL_REMINDER}
${CODE_COPY_REMINDER}

CRITICAL: Use yield_to_parent tool when task is complete.
</system-reminder>`;

export function getSubsequentReminder(threadType: ThreadType): string {
  switch (threadType) {
    case "root":
      return BASE_REMINDER;
    case "subagent_default":
    case "subagent_fast":
      return SUBAGENT_REMINDER;
    case "subagent_explore":
      return `<system-reminder>
${SKILLS_REMINDER}
${BASH_REMINDER}
${EDL_REMINDER}
${EXPLORE_VERIFY_REMINDER}
${CODE_COPY_REMINDER}

CRITICAL: Use yield_to_parent tool when task is complete.
</system-reminder>`;
  }
}
