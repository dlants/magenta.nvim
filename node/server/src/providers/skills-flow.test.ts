import { expect, it } from "vitest";
import { InMemoryFileIO } from "../edl/in-memory-file-io.ts";
import type { Logger } from "../logger.ts";
import { type Harness, withHarness } from "../test/harness.ts";
import { noopLogger } from "../test-helpers.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import { loadSkills } from "./skills.ts";

const SKILLS = "/project/.claude/skills";
const skill = (name: string, description: string, body = "Content\n") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

async function systemPromptWith(files: Record<string, string>) {
  return withHarness(
    { files, options: { skillsPaths: [".claude/skills"] } },
    async (h: Harness) => (await h.createRoot()).thread.systemPrompt,
  );
}

it("loads skills from a directory with skill.md", async () => {
  const prompt = await systemPromptWith({
    [`${SKILLS}/test-skill/skill.md`]: skill(
      "test-skill",
      "A test skill for testing",
    ),
  });
  expect(prompt).toContain("Available Skills");
  expect(prompt).toContain("test-skill");
  expect(prompt).toContain("A test skill for testing");
  expect(prompt).toContain("get_files tool");
});

it("handles case-insensitive skill.md filename", async () => {
  const prompt = await systemPromptWith({
    [`${SKILLS}/case-test/SKILL.MD`]: skill(
      "case-test-skill",
      "Testing case insensitivity",
    ),
  });
  expect(prompt).toContain("case-test-skill");
  expect(prompt).toContain("Testing case insensitivity");
});

it("skips skills with missing frontmatter or required fields", async () => {
  const prompt = await systemPromptWith({
    [`${SKILLS}/no-frontmatter/skill.md`]: "# No Frontmatter\n\nJust text.\n",
    [`${SKILLS}/missing-fields/skill.md`]: "---\nname: only-name\n---\nx\n",
  });
  expect(prompt).not.toContain("no-frontmatter");
  expect(prompt).not.toContain("only-name");
});

it("keeps only one of two skills with a duplicate name", async () => {
  const prompt = await systemPromptWith({
    [`${SKILLS}/skill1/skill.md`]: skill("duplicate-name", "First dup"),
    [`${SKILLS}/skill2/skill.md`]: skill("duplicate-name", "Second dup"),
  });
  expect(prompt).toContain("duplicate-name");
  expect(
    Number(prompt.includes("First dup")) +
      Number(prompt.includes("Second dup")),
  ).toBe(1);
});

it("handles multiple skills", async () => {
  const prompt = await systemPromptWith({
    [`${SKILLS}/skill-a/skill.md`]: skill("skill-a", "First skill"),
    [`${SKILLS}/skill-b/skill.md`]: skill("skill-b", "Second skill"),
  });
  for (const text of ["skill-a", "skill-b", "First skill", "Second skill"]) {
    expect(prompt).toContain(text);
  }
});

it("handles frontmatter with values that are invalid in strict YAML", async () => {
  const prompt = await systemPromptWith({
    [`${SKILLS}/cc/skill.md`]:
      "---\nname: fix-ci-failures\ndescription: Fix failing tests\nallowed-tools: Bash(git show:*), Bash(git fetch: *)\n---\n# Fix\n",
  });
  expect(prompt).toContain("fix-ci-failures");
  expect(prompt).toContain("Fix failing tests");
});

it("omits the skills section when the directory does not exist", async () => {
  expect(await systemPromptWith({})).not.toContain("Available Skills");
});

it("includes skills in system prompt not user messages", () =>
  withHarness(
    {
      files: {
        [`${SKILLS}/skill-a/skill.md`]: skill("skill-a", "First description"),
      },
      options: { skillsPaths: [".claude/skills"] },
    },
    async (h) => {
      const { thread } = await h.createRoot();
      const first = h.send(thread, "hello");
      const stream1 = await h.nextStream();
      expect(stream1.systemPrompt).toContain("First description");
      expect(JSON.stringify(stream1.messages)).not.toContain(
        "Available Skills",
      );
      stream1.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
      await first;
      void h.send(thread, "second message");
      const stream2 = await h.nextStream();
      expect(stream2.systemPrompt).toContain("Available Skills");
      expect(JSON.stringify(stream2.messages.at(-1))).not.toContain(
        "Available Skills",
      );
    },
  ));
it("logs when a skill overrides one with a duplicate name", async () => {
  const infos: string[] = [];
  const logger: Logger = {
    ...noopLogger,
    info: (msg) => infos.push(String(msg)),
  };
  const skills = await loadSkills({
    cwd: "/project" as NvimCwd,
    homeDir: "/home" as HomeDir,
    logger,
    fileIO: new InMemoryFileIO({
      [`${SKILLS}/skill1/skill.md`]: skill("duplicate-name", "First dup"),
      [`${SKILLS}/skill2/skill.md`]: skill("duplicate-name", "Second dup"),
    }),
    options: { skillsPaths: [".claude/skills"], agentsPaths: [] },
  });
  expect(Object.keys(skills)).toEqual(["duplicate-name"]);
  expect(
    infos.some(
      (m) => m.includes('Skill "duplicate-name"') && m.includes("overrides"),
    ),
  ).toBe(true);
});
it("omits the skills section when no skills paths are configured", async () => {
  const prompt = await withHarness(
    {
      files: { [`${SKILLS}/a/skill.md`]: skill("skill-a", "A") },
      options: { skillsPaths: [] },
    },
    async (h) => (await h.createRoot()).thread.systemPrompt,
  );
  expect(prompt).not.toContain("Available Skills");
});
