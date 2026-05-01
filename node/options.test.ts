import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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
      { name: "test", provider: "mock", model: "mock", fastModel: "mock-fast" },
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
    sandbox: structuredClone(DEFAULT_SANDBOX_CONFIG),
    autoContext: [],
    skillsPaths: [],
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
      },
      requireApprovalPatterns: [
        ...DEFAULT_SANDBOX_CONFIG.requireApprovalPatterns,
      ],
      bwrapSandboxViolationPatterns:
        DEFAULT_SANDBOX_CONFIG.bwrapSandboxViolationPatterns,
    });
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
        },
        requireApprovalPatterns: [],
        bwrapSandboxViolationPatterns: ["Permission denied"],
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
        },
        requireApprovalPatterns: [],
        bwrapSandboxViolationPatterns: [],
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
