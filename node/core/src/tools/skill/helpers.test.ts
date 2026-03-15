import { describe, expect, it } from "vitest";
import type { ToolSkillConfig } from "../../provider-options.ts";
import { buildSkillDescription, findSkill } from "./helpers.ts";

const skills: ToolSkillConfig[] = [
  {
    name: "greet",
    description: "Says hello",
    command: ["echo", "hi"],
  },
  {
    name: "deploy",
    description: "Deploys the app",
    command: ["/usr/bin/deploy"],
  },
];

describe("buildSkillDescription", () => {
  it("lists all skills with names and descriptions", () => {
    const desc = buildSkillDescription(skills);
    expect(desc).toContain("**greet**");
    expect(desc).toContain("Says hello");
    expect(desc).toContain("**deploy**");
    expect(desc).toContain("Deploys the app");
  });

  it("includes usage instructions", () => {
    const desc = buildSkillDescription(skills);
    expect(desc).toContain("usage docs");
  });
});

describe("findSkill", () => {
  it("finds a skill by name", () => {
    const skill = findSkill(skills, "greet");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("greet");
    expect(skill!.command).toEqual(["echo", "hi"]);
  });

  it("returns undefined for unknown skill", () => {
    const skill = findSkill(skills, "nonexistent");
    expect(skill).toBeUndefined();
  });
});
