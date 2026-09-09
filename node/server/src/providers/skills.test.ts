import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsFileIO } from "../capabilities/file-io.ts";
import type { Logger } from "../logger.ts";
import type { ProviderOptions } from "../provider-options.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import { loadSkills } from "./skills.ts";

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

let testCounter = 0;
let tmpRoot: string;
let tmpHome: HomeDir;
let tmpCwd: NvimCwd;

beforeEach(async () => {
  tmpRoot = path.join(
    "/tmp/magenta-test",
    `skills-${Date.now()}-${testCounter++}`,
  );
  await fs.mkdir(tmpRoot, { recursive: true });
  tmpHome = path.join(tmpRoot, "home") as HomeDir;
  tmpCwd = path.join(tmpRoot, "cwd") as NvimCwd;
  await fs.mkdir(tmpHome, { recursive: true });
  await fs.mkdir(tmpCwd, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function writeSkill(
  skillsRoot: string,
  name: string,
  description: string,
) {
  const dir = path.join(skillsRoot, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "skill.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
  );
}

function makeContext(options: ProviderOptions) {
  return {
    cwd: tmpCwd,
    logger: noopLogger,
    options,
    fileIO: new FsFileIO(),
    homeDir: tmpHome,
  };
}

describe("loadSkills with hierarchical relative paths", () => {
  it("walks up parent directories above cwd for relative skills paths", async () => {
    const deepCwd = path.join(tmpRoot, "level1", "level2") as NvimCwd;
    await fs.mkdir(deepCwd, { recursive: true });

    await writeSkill(
      path.join(tmpRoot, "level1", ".magenta", "skills"),
      "skill-l1",
      "level1 skill",
    );
    await writeSkill(
      path.join(deepCwd, ".magenta", "skills"),
      "skill-cwd",
      "cwd skill",
    );

    const skills = await loadSkills({
      cwd: deepCwd,
      logger: noopLogger,
      options: {
        skillsPaths: [".magenta/skills"],
        agentsPaths: [],
      },
      fileIO: new FsFileIO(),
      homeDir: tmpHome,
    });

    expect(skills["skill-l1"]).toBeDefined();
    expect(skills["skill-l1"].description).toBe("level1 skill");
    expect(skills["skill-cwd"]).toBeDefined();
    expect(skills["skill-cwd"].description).toBe("cwd skill");
  });

  it("skills closer to cwd override same-named skills from parent directories", async () => {
    const deepCwd = path.join(tmpRoot, "outer", "inner") as NvimCwd;
    await fs.mkdir(deepCwd, { recursive: true });

    await writeSkill(
      path.join(tmpRoot, "outer", ".magenta", "skills"),
      "plan",
      "outer-plan",
    );
    await writeSkill(
      path.join(deepCwd, ".magenta", "skills"),
      "plan",
      "inner-plan",
    );

    const skills = await loadSkills({
      cwd: deepCwd,
      logger: noopLogger,
      options: {
        skillsPaths: [".magenta/skills"],
        agentsPaths: [],
      },
      fileIO: new FsFileIO(),
      homeDir: tmpHome,
    });

    expect(skills.plan).toBeDefined();
    expect(skills.plan.description).toBe("inner-plan");
  });

  it("does not walk up for absolute (tilde-expanded) skills paths", async () => {
    const homeSkillsDir = path.join(tmpHome, ".claude", "skills");
    await writeSkill(homeSkillsDir, "home-skill", "home-only");

    const deepCwd = path.join(tmpRoot, "a", "b") as NvimCwd;
    await fs.mkdir(deepCwd, { recursive: true });
    await writeSkill(
      path.join(tmpRoot, "a", ".claude", "skills"),
      "intermediate",
      "should-not-be-found-via-absolute",
    );

    const skills = await loadSkills({
      cwd: deepCwd,
      logger: noopLogger,
      options: {
        skillsPaths: ["~/.claude/skills"],
        agentsPaths: [],
      },
      fileIO: new FsFileIO(),
      homeDir: tmpHome,
    });

    expect(skills["home-skill"]).toBeDefined();
    expect(skills.intermediate).toBeUndefined();
  });
});

describe("loadSkills with suppressProjectSkills", () => {
  it("drops project-level skill while keeping user-level skill of the same name", async () => {
    const userSkillsDir = path.join(tmpHome, ".claude", "skills");
    const projectSkillsDir = path.join(tmpCwd, ".claude", "skills");
    await writeSkill(userSkillsDir, "plan", "user-plan");
    await writeSkill(projectSkillsDir, "plan", "project-plan");

    const skills = await loadSkills(
      makeContext({
        skillsPaths: ["~/.claude/skills", ".claude/skills"],
        agentsPaths: [],
        suppressProjectSkills: ["plan"],
      }),
    );

    expect(skills.plan).toBeDefined();
    expect(skills.plan.description).toBe("user-plan");
    expect(skills.plan.skillFile).toBe(
      path.join(userSkillsDir, "plan", "skill.md"),
    );
  });

  it("drops project-level skill even when no user-level skill exists", async () => {
    const projectSkillsDir = path.join(tmpCwd, ".claude", "skills");
    await writeSkill(projectSkillsDir, "plan", "project-plan");

    const skills = await loadSkills(
      makeContext({
        skillsPaths: ["~/.claude/skills", ".claude/skills"],
        agentsPaths: [],
        suppressProjectSkills: ["plan"],
      }),
    );

    expect(skills.plan).toBeUndefined();
  });

  it("does not affect project-level skills outside the suppression list", async () => {
    const projectSkillsDir = path.join(tmpCwd, ".claude", "skills");
    await writeSkill(projectSkillsDir, "plan", "project-plan");
    await writeSkill(projectSkillsDir, "browser", "project-browser");

    const skills = await loadSkills(
      makeContext({
        skillsPaths: ["~/.claude/skills", ".claude/skills"],
        agentsPaths: [],
        suppressProjectSkills: ["plan"],
      }),
    );

    expect(skills.plan).toBeUndefined();
    expect(skills.browser).toBeDefined();
    expect(skills.browser.description).toBe("project-browser");
  });
});
