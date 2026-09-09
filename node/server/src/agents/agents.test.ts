import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Logger } from "../logger.ts";
import type { ProviderOptions } from "../provider-options.ts";
import type { NvimCwd } from "../utils/files.ts";
import {
  type AgentsMap,
  extractSystemReminderBlock,
  formatAgentsIntroduction,
  loadAgents,
  parseAgentFile,
} from "./agents.ts";

function createTestLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
  } as Logger;
}

describe("parseAgentFile", () => {
  let tmpDir: string;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses agent file with frontmatter and body", () => {
    const agentFile = path.join(tmpDir, "test.md");
    fs.writeFileSync(
      agentFile,
      `---
name: test-agent
description: A test agent
---

# Test Agent

You are a test agent.`,
    );

    const result = parseAgentFile(agentFile, { logger });
    expect(result).toEqual({
      name: "test-agent",
      description: "A test agent",
      systemPrompt: "# Test Agent\n\nYou are a test agent.",
      systemReminder: undefined,
      fastModel: undefined,
      effort: undefined,
      tier: "leaf",
    });
  });

  it("extracts system_reminder from body", () => {
    const agentFile = path.join(tmpDir, "reminder.md");
    fs.writeFileSync(
      agentFile,
      `---
name: reminder-agent
description: Agent with reminder
---

# Agent Prompt

Do stuff.

<system_reminder>
Remember to yield when done.
Always be concise.
</system_reminder>`,
    );

    const result = parseAgentFile(agentFile, { logger });
    expect(result).toBeDefined();
    expect(result!.systemPrompt).toBe("# Agent Prompt\n\nDo stuff.");
    expect(result!.systemReminder).toBe(
      "Remember to yield when done.\nAlways be concise.",
    );
  });

  it("parses fastModel boolean field", () => {
    const agentFile = path.join(tmpDir, "fast.md");
    fs.writeFileSync(
      agentFile,
      `---
name: fast-agent
description: A fast agent
fastModel: true
---

Fast prompt.`,
    );

    const result = parseAgentFile(agentFile, { logger });
    expect(result).toBeDefined();
    expect(result!.fastModel).toBe(true);
  });

  it("treats fastModel false correctly", () => {
    const agentFile = path.join(tmpDir, "slow.md");
    fs.writeFileSync(
      agentFile,
      `---
name: slow-agent
description: A slow agent
fastModel: false
---

Slow prompt.`,
    );

    const result = parseAgentFile(agentFile, { logger });
    expect(result).toBeDefined();
    expect(result!.fastModel).toBe(false);
  });

  it("parses effort field", () => {
    const agentFile = path.join(tmpDir, "thinker.md");
    fs.writeFileSync(
      agentFile,
      `---
name: thinker
description: A thinker
effort: max
---

Think.`,
    );

    const result = parseAgentFile(agentFile, { logger });
    expect(result).toBeDefined();
    expect(result!.effort).toBe("max");
  });

  it("ignores invalid effort value", () => {
    const agentFile = path.join(tmpDir, "bad-effort.md");
    fs.writeFileSync(
      agentFile,
      `---
name: bad-effort
description: bad
effort: bogus
---

Body.`,
    );

    const result = parseAgentFile(agentFile, { logger });
    expect(result).toBeDefined();
    expect(result!.effort).toBeUndefined();
  });

  it("returns undefined for missing frontmatter", () => {
    const agentFile = path.join(tmpDir, "no-front.md");
    fs.writeFileSync(agentFile, "# No frontmatter\n\nJust content.");

    const result = parseAgentFile(agentFile, { logger });
    expect(result).toBeUndefined();
  });

  it("returns undefined for missing name", () => {
    const agentFile = path.join(tmpDir, "no-name.md");
    fs.writeFileSync(
      agentFile,
      `---
description: Missing name
---

Content.`,
    );

    const result = parseAgentFile(agentFile, { logger });
    expect(result).toBeUndefined();
  });

  it("returns undefined for missing description", () => {
    const agentFile = path.join(tmpDir, "no-desc.md");
    fs.writeFileSync(
      agentFile,
      `---
name: no-desc-agent
---

Content.`,
    );

    const result = parseAgentFile(agentFile, { logger });
    expect(result).toBeUndefined();
  });

  it("parses tier: leaf from frontmatter", () => {
    const agentFile = path.join(tmpDir, "leaf.md");
    fs.writeFileSync(
      agentFile,
      `---
name: leaf-agent
description: A leaf agent
tier: leaf
---

Leaf prompt.`,
    );

    const result = parseAgentFile(agentFile, { logger });
    expect(result).toBeDefined();
    expect(result!.tier).toBe("leaf");
  });

  it("parses tier: orchestrator from frontmatter", () => {
    const agentFile = path.join(tmpDir, "orch.md");
    fs.writeFileSync(
      agentFile,
      `---
name: orch-agent
description: An orchestrator agent
tier: orchestrator
---

Orchestrator prompt.`,
    );

    const result = parseAgentFile(agentFile, { logger });
    expect(result).toBeDefined();
    expect(result!.tier).toBe("orchestrator");
  });

  it("defaults tier to leaf when not specified", () => {
    const agentFile = path.join(tmpDir, "notier.md");
    fs.writeFileSync(
      agentFile,
      `---
name: notier-agent
description: No tier specified
---

No tier prompt.`,
    );

    const result = parseAgentFile(agentFile, { logger });
    expect(result).toBeDefined();
    expect(result!.tier).toBe("leaf");
  });
});

describe("loadAgents", () => {
  let tmpDir: string;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-load-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("discovers .md files from agents directory", () => {
    const agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(agentsDir);
    fs.writeFileSync(
      path.join(agentsDir, "alpha.md"),
      `---
name: alpha
description: Alpha agent
---

Alpha prompt.`,
    );
    fs.writeFileSync(
      path.join(agentsDir, "beta.md"),
      `---
name: beta
description: Beta agent
---

Beta prompt.`,
    );

    const options: ProviderOptions = {
      skillsPaths: [],
      agentsPaths: [agentsDir],
    };

    const result = loadAgents({
      cwd: tmpDir as NvimCwd,
      logger,
      options,
    });

    expect(Object.keys(result)).toHaveLength(2);
    expect(result.alpha).toBeDefined();
    expect(result.alpha.name).toBe("alpha");
    expect(result.beta).toBeDefined();
    expect(result.beta.name).toBe("beta");
  });

  it("later directories override earlier ones", () => {
    const dir1 = path.join(tmpDir, "agents1");
    const dir2 = path.join(tmpDir, "agents2");
    fs.mkdirSync(dir1);
    fs.mkdirSync(dir2);

    fs.writeFileSync(
      path.join(dir1, "agent.md"),
      `---
name: shared
description: From dir1
---

Prompt 1.`,
    );
    fs.writeFileSync(
      path.join(dir2, "agent.md"),
      `---
name: shared
description: From dir2
---

Prompt 2.`,
    );

    const options: ProviderOptions = {
      skillsPaths: [],
      agentsPaths: [dir1, dir2],
    };

    const result = loadAgents({
      cwd: tmpDir as NvimCwd,
      logger,
      options,
    });

    expect(result.shared.description).toBe("From dir2");
  });

  it("ignores non-.md files", () => {
    const agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(agentsDir);
    fs.writeFileSync(path.join(agentsDir, "readme.txt"), "not an agent");
    fs.writeFileSync(
      path.join(agentsDir, "real.md"),
      `---
name: real
description: Real agent
---

Prompt.`,
    );

    const options: ProviderOptions = {
      skillsPaths: [],
      agentsPaths: [agentsDir],
    };

    const result = loadAgents({
      cwd: tmpDir as NvimCwd,
      logger,
      options,
    });

    expect(Object.keys(result)).toHaveLength(1);
    expect(result.real).toBeDefined();
  });

  it("skips directories inside agents path", () => {
    const agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(agentsDir);
    fs.mkdirSync(path.join(agentsDir, "subdir"));
    fs.writeFileSync(
      path.join(agentsDir, "subdir", "nested.md"),
      `---
name: nested
description: Should not be found
---

Prompt.`,
    );

    const options: ProviderOptions = {
      skillsPaths: [],
      agentsPaths: [agentsDir],
    };

    const result = loadAgents({
      cwd: tmpDir as NvimCwd,
      logger,
      options,
    });

    expect(Object.keys(result)).toHaveLength(0);
  });

  it("returns empty map for empty agentsPaths", () => {
    const options: ProviderOptions = {
      skillsPaths: [],
      agentsPaths: [],
    };

    const result = loadAgents({
      cwd: tmpDir as NvimCwd,
      logger,
      options,
    });

    expect(Object.keys(result)).toHaveLength(0);
  });

  it("handles non-existent directories gracefully", () => {
    const options: ProviderOptions = {
      skillsPaths: [],
      agentsPaths: ["/nonexistent/path/to/agents"],
    };

    const result = loadAgents({
      cwd: tmpDir as NvimCwd,
      logger,
      options,
    });

    expect(Object.keys(result)).toHaveLength(0);
  });
});

describe("builtin agents", () => {
  const logger = createTestLogger();
  const builtinDir = path.join(__dirname);

  it("loads default, root, and docker-root from builtin path", () => {
    const options: ProviderOptions = {
      skillsPaths: [],
      agentsPaths: [builtinDir],
    };

    const result = loadAgents({
      cwd: "/tmp" as NvimCwd,
      logger,
      options,
    });

    expect(result.default).toBeDefined();
    expect(result.default.tier).toBe("thread");
    expect(result.default.systemPrompt).toContain("# Be Concise");
    expect(result.default.systemReminder).toBeDefined();

    expect(result.subagent).toBeDefined();
    expect(result.subagent.tier).toBe("thread");
    expect(result.subagent.systemPrompt).toContain("# Role");

    expect(result.docker).toBeDefined();
    expect(result.docker.tier).toBe("thread");
    expect(result.docker.systemPrompt).toContain("# Docker Environment");
    expect(result.docker.systemReminder).toBeDefined();
  });

  it("allows user override of default agent", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-override-"));
    try {
      fs.writeFileSync(
        path.join(tmpDir, "default.md"),
        `---
name: default
description: Custom default agent
tier: thread
---

Custom default prompt.`,
      );

      const options: ProviderOptions = {
        skillsPaths: [],
        agentsPaths: [builtinDir, tmpDir],
      };

      const result = loadAgents({
        cwd: "/tmp" as NvimCwd,
        logger,
        options,
      });

      expect(result.default.description).toBe("Custom default agent");
      expect(result.default.systemPrompt).toBe("Custom default prompt.");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("extractSystemReminderBlock", () => {
  it("returns the inner text of a well-formed block", () => {
    const body =
      "prompt text\n<system_reminder>\nremember this\n</system_reminder>\nmore";
    expect(extractSystemReminderBlock(body)).toBe("remember this");
  });

  it("returns undefined when there is no block", () => {
    expect(extractSystemReminderBlock("just a prompt")).toBeUndefined();
  });

  it("returns undefined for multiple blocks", () => {
    const body =
      "<system_reminder>a</system_reminder><system_reminder>b</system_reminder>";
    expect(extractSystemReminderBlock(body)).toBeUndefined();
  });

  it("returns undefined for a malformed (reversed) block", () => {
    const body = "</system_reminder>oops<system_reminder>";
    expect(extractSystemReminderBlock(body)).toBeUndefined();
  });
});

describe("formatAgentsIntroduction", () => {
  it("returns empty string for no agents", () => {
    const result = formatAgentsIntroduction({});
    expect(result).toBe("");
  });

  it("formats agent list", () => {
    const agents: AgentsMap = {
      explore: {
        name: "explore",
        description: "Explore the codebase",
        systemPrompt: "prompt",
        systemReminder: undefined,
        fastModel: undefined,
        thinkingModel: undefined,
        effort: undefined,
        tier: "leaf" as const,
      },
    };

    const result = formatAgentsIntroduction(agents);
    expect(result).toContain("Available Agents");
    expect(result).toContain("- explore:");
    expect(result).toContain("Explore the codebase");
  });
});
