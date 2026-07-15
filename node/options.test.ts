import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_SKILLS_PATH,
  DEFAULT_SANDBOX_CONFIG,
  loadProjectSettings,
  loadUserSettings,
  type MagentaOptions,
  mergeOptions,
  parseOptions,
  parseProjectOptions,
} from "./options.ts";
import type { NvimCwd } from "./utils/files.ts";

function makeBaseOptions(overrides?: Partial<MagentaOptions>): MagentaOptions {
  return {
    profiles: [
      {
        name: "test",
        provider: "mock",
        model: "mock",
        fastModel: "mock-fast",
        thinkingModel: "mock",
      },
    ],
    activeProfile: "test",
    sidebarPosition: "left",
    sidebarPositionOpts: {
      above: { displayHeightPercentage: 0.3, inputHeightPercentage: 0.1 },
      below: { displayHeightPercentage: 0.3, inputHeightPercentage: 0.1 },
      tab: { displayHeightPercentage: 0.8 },
      left: { widthPercentage: 0.4, displayHeightPercentage: 0.8 },
      right: { widthPercentage: 0.4, displayHeightPercentage: 0.8 },
    },
    maxConcurrentSubagents: 3,
    maxConcurrentFastSubagents: 8,
    autoCompactThreshold: 300000,
    sandbox: structuredClone(DEFAULT_SANDBOX_CONFIG),
    autoContext: [],
    hierarchyContextFileNames: ["context.md", "agent.md"],
    skillsPaths: [],
    scriptsPaths: [],
    suppressProjectSkills: [],
    agentsPaths: [],
    mcpServers: {},
    customCommands: [],
    ...overrides,
  };
}

const noopLogger = {
  warn: () => {},
  error: () => {},
};

describe("parseSandboxConfig", () => {
  it("should parse valid sandbox config", () => {
    const input = {
      profiles: [{ name: "test", provider: "mock" }],
      sandbox: {
        filesystem: {
          allowWrite: ["/tmp"],
          denyWrite: [".secret"],
          denyRead: ["~/.ssh"],
        },
        network: {
          allowedDomains: ["example.com"],
          deniedDomains: ["evil.com"],
          allowUnixSockets: [],
          allowAllUnixSockets: false,
        },
      },
    };
    const result = parseOptions(input, noopLogger);
    expect(result.sandbox).toEqual({
      filesystem: {
        allowWrite: [...DEFAULT_SANDBOX_CONFIG.filesystem.allowWrite, "/tmp"],
        denyWrite: [...DEFAULT_SANDBOX_CONFIG.filesystem.denyWrite, ".secret"],
        denyRead: [...DEFAULT_SANDBOX_CONFIG.filesystem.denyRead, "~/.ssh"],
        allowRead: [...DEFAULT_SANDBOX_CONFIG.filesystem.allowRead],
      },
      network: {
        allowedDomains: [
          ...DEFAULT_SANDBOX_CONFIG.network.allowedDomains,
          "example.com",
        ],
        deniedDomains: [
          ...DEFAULT_SANDBOX_CONFIG.network.deniedDomains,
          "evil.com",
        ],
        allowUnixSockets: [...DEFAULT_SANDBOX_CONFIG.network.allowUnixSockets],
        allowAllUnixSockets: DEFAULT_SANDBOX_CONFIG.network.allowAllUnixSockets,
        onUnknownHost: DEFAULT_SANDBOX_CONFIG.network.onUnknownHost,
      },
      requireApprovalPatterns: [
        ...DEFAULT_SANDBOX_CONFIG.requireApprovalPatterns,
      ],
      strace: { ...DEFAULT_SANDBOX_CONFIG.strace },
    });
  });

  it("parses network.onUnknownHost and strace.autoAllowViolations", () => {
    const input = {
      profiles: [{ name: "test", provider: "mock" }],
      sandbox: {
        network: { onUnknownHost: "allow" },
        strace: { autoAllowViolations: true },
      },
    };
    const result = parseOptions(input, noopLogger);
    expect(result.sandbox.network.onUnknownHost).toBe("allow");
    expect(result.sandbox.strace.autoAllowViolations).toBe(true);
  });

  it("warns and defaults on invalid network.onUnknownHost", () => {
    const warnings: string[] = [];
    const logger = { warn: (m: string) => warnings.push(m), error: () => {} };
    const input = {
      profiles: [{ name: "test", provider: "mock" }],
      sandbox: { network: { onUnknownHost: "bogus" } },
    };
    const result = parseOptions(input, logger);
    expect(result.sandbox.network.onUnknownHost).toBe("prompt");
    expect(warnings.some((w) => w.includes("onUnknownHost"))).toBe(true);
  });

  it("defaults onUnknownHost to prompt and autoAllowViolations to false", () => {
    const input = {
      profiles: [{ name: "test", provider: "mock" }],
      sandbox: {},
    };
    const result = parseOptions(input, noopLogger);
    expect(result.sandbox.network.onUnknownHost).toBe("prompt");
    expect(result.sandbox.strace.autoAllowViolations).toBe(false);
  });

  it("should fill defaults for missing fields", () => {
    const input = {
      profiles: [{ name: "test", provider: "mock" }],
      sandbox: {},
    };
    const result = parseOptions(input, noopLogger);
    expect(result.sandbox.filesystem).toEqual(
      DEFAULT_SANDBOX_CONFIG.filesystem,
    );
    expect(result.sandbox.network).toEqual(DEFAULT_SANDBOX_CONFIG.network);
  });

  it("should use all defaults when sandbox is not provided", () => {
    const input = {
      profiles: [{ name: "test", provider: "mock" }],
    };
    const result = parseOptions(input, noopLogger);
    expect(result.sandbox).toEqual(DEFAULT_SANDBOX_CONFIG);
  });
});

describe("DEFAULT_SANDBOX_CONFIG security", () => {
  it("should deny writes to both project and home .magenta directories", () => {
    expect(DEFAULT_SANDBOX_CONFIG.filesystem.denyWrite).toContain(".magenta");
    expect(DEFAULT_SANDBOX_CONFIG.filesystem.denyWrite).toContain("~/.magenta");
  });
});

describe("parseProjectOptions sandbox", () => {
  it("should parse sandbox from project options", () => {
    const result = parseProjectOptions(
      {
        sandbox: {
          filesystem: { denyRead: ["/secret"] },
        },
      },
      noopLogger,
    );
    expect(result.sandbox?.filesystem.denyRead).toEqual(["/secret"]);
    expect(result.sandbox?.filesystem.allowWrite).toEqual([]);
  });
});

describe("mergeOptions", () => {
  it("should concatenate sandbox arrays", () => {
    const base = makeBaseOptions({
      sandbox: {
        filesystem: {
          allowWrite: ["./"],
          denyWrite: [".env"],
          denyRead: ["~/.ssh"],
          allowRead: [],
        },
        network: {
          allowedDomains: ["registry.npmjs.org"],
          deniedDomains: [],
          allowUnixSockets: [],
          allowAllUnixSockets: false,
          onUnknownHost: "prompt",
        },
        requireApprovalPatterns: [],
        strace: {
          autoAllowViolations: false,
        },
      },
    });

    const merged = mergeOptions(base, {
      sandbox: {
        filesystem: {
          allowWrite: ["/tmp"],
          denyWrite: [".git/hooks/"],
          denyRead: ["~/.aws"],
          allowRead: [],
        },
        network: {
          allowedDomains: ["github.com"],
          deniedDomains: ["evil.com"],
          allowUnixSockets: [],
          allowAllUnixSockets: false,
          onUnknownHost: "prompt",
        },
        requireApprovalPatterns: [],
        strace: {
          autoAllowViolations: false,
        },
      },
    });

    expect(merged.sandbox.filesystem.allowWrite).toEqual(["./", "/tmp"]);
    expect(merged.sandbox.filesystem.denyWrite).toEqual([
      ".env",
      ".git/hooks/",
    ]);
    expect(merged.sandbox.filesystem.denyRead).toEqual(["~/.ssh", "~/.aws"]);
    expect(merged.sandbox.network.allowedDomains).toEqual([
      "registry.npmjs.org",
      "github.com",
    ]);
    expect(merged.sandbox.network.deniedDomains).toEqual(["evil.com"]);
  });

  it("should keep base sandbox when project has no sandbox", () => {
    const base = makeBaseOptions();
    const merged = mergeOptions(base, {});
    expect(merged.sandbox).toEqual(base.sandbox);
  });
  it("lets project scalars override user scalars (last-writer-wins)", () => {
    const base = makeBaseOptions();
    const projectSandbox = parseProjectOptions(
      {
        sandbox: {
          network: { onUnknownHost: "deny" },
          strace: { autoAllowViolations: true },
        },
      },
      noopLogger,
    ).sandbox!;
    const merged = mergeOptions(base, { sandbox: projectSandbox });
    expect(merged.sandbox.network.onUnknownHost).toBe("deny");
    expect(merged.sandbox.strace.autoAllowViolations).toBe(true);
  });
});

describe("parseProfiles tokenRefreshCommand", () => {
  it("accepts a non-empty string", () => {
    const warnings: string[] = [];
    const logger = {
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    };
    const result = parseOptions(
      {
        profiles: [
          {
            name: "bedrock",
            provider: "bedrock",
            model: "us.anthropic.claude-sonnet-4-5-v1:0",
            tokenRefreshCommand: "aws sso login --profile myprofile",
          },
        ],
      },
      logger,
    );
    expect(result.profiles[0].tokenRefreshCommand).toBe(
      "aws sso login --profile myprofile",
    );
    expect(warnings).toEqual([]);
  });

  it("warns and drops a non-string value", () => {
    const warnings: string[] = [];
    const logger = {
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    };
    const result = parseOptions(
      {
        profiles: [
          {
            name: "bedrock",
            provider: "bedrock",
            model: "us.anthropic.claude-sonnet-4-5-v1:0",
            tokenRefreshCommand: 42,
          },
        ],
      },
      logger,
    );
    expect(result.profiles[0].tokenRefreshCommand).toBeUndefined();
    expect(warnings.some((w) => w.includes("tokenRefreshCommand"))).toBe(true);
  });

  it("warns and drops an empty string", () => {
    const warnings: string[] = [];
    const logger = {
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    };
    const result = parseOptions(
      {
        profiles: [
          {
            name: "bedrock",
            provider: "bedrock",
            model: "us.anthropic.claude-sonnet-4-5-v1:0",
            tokenRefreshCommand: "",
          },
        ],
      },
      logger,
    );
    expect(result.profiles[0].tokenRefreshCommand).toBeUndefined();
    expect(warnings.some((w) => w.includes("tokenRefreshCommand"))).toBe(true);
  });
});

describe("parseCustomCommands systemReminder", () => {
  it("surfaces a string systemReminder on the parsed command", () => {
    const warnings: string[] = [];
    const logger = {
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    };
    const result = parseOptions(
      {
        customCommands: [
          { name: "@foo", text: "foo", systemReminder: "remember foo" },
        ],
        profiles: [{ name: "test", provider: "mock" }],
      },
      logger,
    );
    expect(result.customCommands[0].systemReminder).toBe("remember foo");
    expect(warnings).toEqual([]);
  });

  it("warns and drops a non-string systemReminder", () => {
    const warnings: string[] = [];
    const logger = {
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    };
    const result = parseOptions(
      {
        customCommands: [{ name: "@foo", text: "foo", systemReminder: 42 }],
        profiles: [{ name: "test", provider: "mock" }],
      },
      logger,
    );
    expect(result.customCommands[0].systemReminder).toBeUndefined();
    expect(warnings.some((w) => w.includes("systemReminder"))).toBe(true);
  });
});

describe("parseProfiles thinking.effort", () => {
  it("accepts a valid effort value", () => {
    const warnings: string[] = [];
    const logger = {
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    };
    const result = parseOptions(
      {
        profiles: [
          {
            name: "test",
            provider: "anthropic",
            model: "claude-opus-4-7",
            thinking: { enabled: true, effort: "max" },
          },
        ],
      },
      logger,
    );
    expect(result.profiles[0].thinking?.effort).toBe("max");
    expect(warnings).toEqual([]);
  });

  it("warns and drops an invalid effort value", () => {
    const warnings: string[] = [];
    const logger = {
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
    };
    const result = parseOptions(
      {
        profiles: [
          {
            name: "test",
            provider: "anthropic",
            model: "claude-opus-4-7",
            thinking: { enabled: true, effort: "turbo" },
          },
        ],
      },
      logger,
    );
    expect(result.profiles[0].thinking?.effort).toBeUndefined();
    expect(warnings.some((w) => w.includes("Invalid effort"))).toBe(true);
  });
});

describe("suppressProjectSkills", () => {
  let testCounter = 0;
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = path.join(
      "/tmp/magenta-test",
      `options-${Date.now()}-${testCounter++}`,
    );
    await fs.mkdir(tmpRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("parseOptions populates suppressProjectSkills from input", () => {
    const result = parseOptions(
      {
        profiles: [{ name: "test", provider: "mock" }],
        suppressProjectSkills: ["plan"],
      },
      noopLogger,
    );
    expect(result.suppressProjectSkills).toEqual(["plan"]);
  });

  it("parseOptions prepends BUILTIN_SKILLS_PATH when user provides skillsPaths", () => {
    const result = parseOptions(
      {
        profiles: [{ name: "test", provider: "mock" }],
        skillsPaths: ["~/.magenta/skills", ".magenta/skills"],
      },
      noopLogger,
    );
    expect(result.skillsPaths).toEqual([
      BUILTIN_SKILLS_PATH,
      "~/.magenta/skills",
      ".magenta/skills",
    ]);
  });

  it("parseOptions includes BUILTIN_SKILLS_PATH by default", () => {
    const result = parseOptions(
      {
        profiles: [{ name: "test", provider: "mock" }],
      },
      noopLogger,
    );
    expect(result.skillsPaths).toContain(BUILTIN_SKILLS_PATH);
  });

  it("parseOptions defaults suppressProjectSkills to empty array", () => {
    const result = parseOptions(
      {
        profiles: [{ name: "test", provider: "mock" }],
      },
      noopLogger,
    );
    expect(result.suppressProjectSkills).toEqual([]);
  });

  it("loadProjectSettings strips suppressProjectSkills and warns", async () => {
    const magentaDir = path.join(tmpRoot, ".magenta");
    await fs.mkdir(magentaDir, { recursive: true });
    await fs.writeFile(
      path.join(magentaDir, "options.json"),
      JSON.stringify({ suppressProjectSkills: ["plan"] }),
    );

    const warnings: string[] = [];
    const logger = { warn: (msg: string) => warnings.push(msg) };

    const result = loadProjectSettings(tmpRoot as NvimCwd, logger);

    expect(result).toBeDefined();
    expect(result?.suppressProjectSkills).toBeUndefined();
    expect(warnings.some((w) => w.includes("suppressProjectSkills"))).toBe(
      true,
    );
  });

  it("loadUserSettings retains suppressProjectSkills", async () => {
    const magentaDir = path.join(tmpRoot, ".magenta");
    await fs.mkdir(magentaDir, { recursive: true });
    await fs.writeFile(
      path.join(magentaDir, "options.json"),
      JSON.stringify({ suppressProjectSkills: ["plan"] }),
    );

    const result = loadUserSettings(tmpRoot, noopLogger);

    expect(result).toBeDefined();
    expect(result?.suppressProjectSkills).toEqual(["plan"]);
  });
});

describe("autoCompact options", () => {
  it("defaults autoCompactThreshold to 300000 and leaves prompt unset", () => {
    const result = parseOptions(
      { profiles: [{ name: "test", provider: "mock" }] },
      noopLogger,
    );
    expect(result.autoCompactThreshold).toBe(300000);
    expect(result.autoCompactPrompt).toBeUndefined();
  });

  it("parses a valid threshold and prompt", () => {
    const result = parseOptions(
      {
        profiles: [{ name: "test", provider: "mock" }],
        autoCompactThreshold: 150000,
        autoCompactPrompt: "custom compaction prompt",
      },
      noopLogger,
    );
    expect(result.autoCompactThreshold).toBe(150000);
    expect(result.autoCompactPrompt).toBe("custom compaction prompt");
  });

  it("rejects a non-positive threshold and a blank prompt", () => {
    const result = parseOptions(
      {
        profiles: [{ name: "test", provider: "mock" }],
        autoCompactThreshold: 0,
        autoCompactPrompt: "   ",
      },
      noopLogger,
    );
    expect(result.autoCompactThreshold).toBe(300000);
    expect(result.autoCompactPrompt).toBeUndefined();
  });

  it("parseProjectOptions parses valid auto-compact scalars", () => {
    const result = parseProjectOptions(
      {
        autoCompactThreshold: 120000,
        autoCompactPrompt: "project side prompt",
      },
      noopLogger,
    );
    expect(result.autoCompactThreshold).toBe(120000);
    expect(result.autoCompactPrompt).toBe("project side prompt");
  });

  it("parseProjectOptions rejects non-positive threshold and blank prompt", () => {
    const result = parseProjectOptions(
      {
        autoCompactThreshold: -5,
        autoCompactPrompt: "   ",
      },
      noopLogger,
    );
    expect(result.autoCompactThreshold).toBeUndefined();
    expect(result.autoCompactPrompt).toBeUndefined();
  });

  it("lets project settings override auto-compact scalars", () => {
    const base = makeBaseOptions();
    const merged = mergeOptions(base, {
      autoCompactThreshold: 200000,
      autoCompactPrompt: "project prompt",
    });
    expect(merged.autoCompactThreshold).toBe(200000);
    expect(merged.autoCompactPrompt).toBe("project prompt");
  });
});
