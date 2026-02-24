import { describe, it, expect } from "vitest";
import { withDriver } from "../test/preamble.ts";
import * as fs from "node:fs";
import * as path from "node:path";

describe("Skills", () => {
  it("loads skills from a directory with skill.md", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skillDir = path.join(tmpDir, ".claude", "skills", "test-skill");
          await fs.promises.mkdir(skillDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(skillDir, "skill.md"),
            `---
name: test-skill
description: A test skill for testing
---

# Test Skill

This is the content of the test skill.
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const thread = driver.magenta.chat.getActiveThread();
        const systemPrompt = thread.state.systemPrompt;

        expect(systemPrompt).toContain("Available Skills");
        expect(systemPrompt).toContain("test-skill");
        expect(systemPrompt).toContain("A test skill for testing");
      },
    );
  });

  it("handles case-insensitive skill.md filename", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skillDir = path.join(tmpDir, ".claude", "skills", "case-test");
          await fs.promises.mkdir(skillDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(skillDir, "SKILL.MD"),
            `---
name: case-test-skill
description: Testing case insensitivity
---
Content here
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const thread = driver.magenta.chat.getActiveThread();
        const systemPrompt = thread.state.systemPrompt;

        expect(systemPrompt).toContain("case-test-skill");
        expect(systemPrompt).toContain("Testing case insensitivity");
      },
    );
  });

  it("skips skills with missing YAML frontmatter", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skillDir = path.join(
            tmpDir,
            ".claude",
            "skills",
            "no-frontmatter",
          );
          await fs.promises.mkdir(skillDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(skillDir, "skill.md"),
            `# No Frontmatter

Just regular markdown content without frontmatter.
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const thread = driver.magenta.chat.getActiveThread();
        const systemPrompt = thread.state.systemPrompt;

        // The invalid skill should not appear, but built-in skills will still be present
        expect(systemPrompt).not.toContain("no-frontmatter");
      },
    );
  });

  it("skips skills with missing required fields", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skillDir = path.join(
            tmpDir,
            ".claude",
            "skills",
            "missing-fields",
          );
          await fs.promises.mkdir(skillDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(skillDir, "skill.md"),
            `---
name: only-name
---
Content
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const thread = driver.magenta.chat.getActiveThread();
        const systemPrompt = thread.state.systemPrompt;

        // The invalid skill should not appear, but built-in skills will still be present
        expect(systemPrompt).not.toContain("only-name");
      },
    );
  });

  it("warns about duplicate skill names", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skill1Dir = path.join(tmpDir, ".claude", "skills", "skill1");
          const skill2Dir = path.join(tmpDir, ".claude", "skills", "skill2");

          await fs.promises.mkdir(skill1Dir, { recursive: true });
          await fs.promises.mkdir(skill2Dir, { recursive: true });

          await fs.promises.writeFile(
            path.join(skill1Dir, "skill.md"),
            `---
name: duplicate-name
description: First skill with this name
---
Content 1
`,
          );

          await fs.promises.writeFile(
            path.join(skill2Dir, "skill.md"),
            `---
name: duplicate-name
description: Second skill with this name
---
Content 2
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const thread = driver.magenta.chat.getActiveThread();
        const systemPrompt = thread.state.systemPrompt;

        // Should contain the duplicate-name skill
        expect(systemPrompt).toContain("duplicate-name");

        // The description should be one of the two (whichever was found first)
        const hasFirstSkill = systemPrompt.includes(
          "First skill with this name",
        );
        const hasSecondSkill = systemPrompt.includes(
          "Second skill with this name",
        );
        expect(hasFirstSkill || hasSecondSkill).toBe(true);
        // Should only have one of them, not both
        expect(hasFirstSkill && hasSecondSkill).toBe(false);
      },
    );
  });

  it("includes skills in system prompt", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skillDir = path.join(tmpDir, ".claude", "skills", "intro-test");
          await fs.promises.mkdir(skillDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(skillDir, "skill.md"),
            `---
name: intro-skill
description: Testing introduction generation
---
Content
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const thread = driver.magenta.chat.getActiveThread();
        const systemPrompt = thread.state.systemPrompt;

        expect(systemPrompt).toContain("Available Skills");
        expect(systemPrompt).toContain("intro-skill");
        expect(systemPrompt).toContain("Testing introduction generation");
        expect(systemPrompt).toContain("get_file tool");
      },
    );
  });

  it("includes built-in skills even when no user skills are configured", async () => {
    await withDriver(
      {
        options: {
          skillsPaths: [],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const thread = driver.magenta.chat.getActiveThread();
        const systemPrompt = thread.state.systemPrompt;

        // Built-in skills should always be present
        expect(systemPrompt).toContain("Available Skills");
        expect(systemPrompt).toContain("learn");
        expect(systemPrompt).toContain("plan");
      },
    );
  });

  it("handles multiple skills from different directories", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skill1Dir = path.join(tmpDir, ".claude", "skills", "skill-a");
          const skill2Dir = path.join(tmpDir, ".claude", "skills", "skill-b");

          await fs.promises.mkdir(skill1Dir, { recursive: true });
          await fs.promises.mkdir(skill2Dir, { recursive: true });

          await fs.promises.writeFile(
            path.join(skill1Dir, "skill.md"),
            `---
name: skill-a
description: First skill
---
Content A
`,
          );

          await fs.promises.writeFile(
            path.join(skill2Dir, "skill.md"),
            `---
name: skill-b
description: Second skill
---
Content B
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const thread = driver.magenta.chat.getActiveThread();
        const systemPrompt = thread.state.systemPrompt;

        expect(systemPrompt).toContain("Available Skills");
        expect(systemPrompt).toContain("skill-a");
        expect(systemPrompt).toContain("skill-b");
        expect(systemPrompt).toContain("First skill");
        expect(systemPrompt).toContain("Second skill");
      },
    );
  });

  it("handles non-existent skills directory gracefully", async () => {
    await withDriver(
      {
        options: {
          skillsPaths: [".claude/skills"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const thread = driver.magenta.chat.getActiveThread();
        const systemPrompt = thread.state.systemPrompt;

        // Built-in skills should still be present even if user skills dir doesn't exist
        expect(systemPrompt).toContain("Available Skills");
        expect(systemPrompt).toContain("learn");
        expect(systemPrompt).toContain("plan");
      },
    );
  });

  it("includes skills in system prompt not user messages", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const skill1Dir = path.join(tmpDir, ".claude", "skills", "skill-a");
          const skill2Dir = path.join(tmpDir, ".claude", "skills", "skill-b");

          await fs.promises.mkdir(skill1Dir, { recursive: true });
          await fs.promises.mkdir(skill2Dir, { recursive: true });

          await fs.promises.writeFile(
            path.join(skill1Dir, "skill.md"),
            `---
name: skill-a
description: First skill description
---
Content A
`,
          );

          await fs.promises.writeFile(
            path.join(skill2Dir, "skill.md"),
            `---
name: skill-b
description: Second skill description
---
Content B
`,
          );
        },
        options: {
          skillsPaths: [".claude/skills"],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        // Send first user message
        await driver.inputMagentaText("hello");
        await driver.send();

        const firstRequest = await driver.mockAnthropic.awaitPendingStream();

        // Check that skills are in the system prompt
        const systemPrompt = firstRequest.systemPrompt;
        expect(systemPrompt).toContain("Available Skills");
        expect(systemPrompt).toContain("skill-a");
        expect(systemPrompt).toContain("skill-b");
        expect(systemPrompt).toContain("First skill description");
        expect(systemPrompt).toContain("Second skill description");
        expect(systemPrompt).toContain("get_file tool");

        // Check that skills are NOT in the first user message
        const firstMessageContent = firstRequest.messages[0].content;
        const textContent = Array.isArray(firstMessageContent)
          ? firstMessageContent.find((c) => c.type === "text")?.text
          : firstMessageContent;

        expect(textContent).not.toContain("Available Skills");
        expect(textContent).toContain("hello");

        firstRequest.respond({
          stopReason: "end_turn",
          text: "Got it!",
          toolRequests: [],
        });

        // Send second user message
        await driver.inputMagentaText("second message");
        await driver.send();

        const secondRequest = await driver.mockAnthropic.awaitPendingStream();

        // Check that skills are still in system prompt
        const secondSystemPrompt = secondRequest.systemPrompt;
        expect(secondSystemPrompt).toContain("Available Skills");

        // Check that skills are NOT in the second user message
        const secondMessageContent =
          secondRequest.messages[secondRequest.messages.length - 1].content;
        const secondTextContent = Array.isArray(secondMessageContent)
          ? secondMessageContent.find((c) => c.type === "text")?.text
          : secondMessageContent;

        expect(secondTextContent).not.toContain("Available Skills");
        expect(secondTextContent).toContain("second message");
      },
    );
  });
});
