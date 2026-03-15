import type { ToolSkillConfig } from "../../provider-options.ts";

export function buildSkillDescription(skills: ToolSkillConfig[]): string {
  const skillList = skills
    .map((s) => `- **${s.name}**: ${s.description}`)
    .join("\n");

  return `Execute a configured tool skill by name. Available skills:

${skillList}

To get usage docs for a skill, call with just the skill name (omit input).
To execute a skill, provide both the skill name and an input object.`;
}

export function findSkill(
  skills: ToolSkillConfig[],
  name: string,
): ToolSkillConfig | undefined {
  return skills.find((s) => s.name === name);
}
