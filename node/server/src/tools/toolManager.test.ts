import { describe, expect, it } from "vitest";
import type { ToolCapability } from "./tool-registry.ts";
import { getToolSpecs } from "./toolManager.ts";

const noopMcpToolManager = { getToolSpecs: () => [] };

describe("getToolSpecs capability filtering", () => {
  it("returns all tools for thread type when no capabilities filter provided", () => {
    const specs = getToolSpecs("root", noopMcpToolManager);
    const names = specs.map((s) => s.name);
    expect(names).toContain("hover");
    expect(names).toContain("bash_command");
    expect(names).toContain("get_files");
  });

  it("excludes lsp tools when lsp capability is missing", () => {
    const caps: Set<ToolCapability> = new Set(["file-io", "shell", "threads"]);
    const specs = getToolSpecs("root", noopMcpToolManager, caps);
    const names = specs.map((s) => s.name);
    expect(names).not.toContain("hover");
    expect(names).not.toContain("find_references");
    expect(names).toContain("bash_command");
    expect(names).toContain("get_files");
    expect(names).toContain("edl");
  });

  it("includes tools with no required capabilities regardless of filter", () => {
    const caps: Set<ToolCapability> = new Set(["file-io"]);
    const specs = getToolSpecs("root", noopMcpToolManager, caps);
    const names = specs.map((s) => s.name);
    expect(names).toContain("get_files");
    expect(names).toContain("edl");
    expect(names).not.toContain("bash_command");
    expect(names).not.toContain("spawn_subagents");
  });

  it("includes nvim_lua for root only when nvim capability is present", () => {
    const withNvim: Set<ToolCapability> = new Set([
      "file-io",
      "shell",
      "threads",
      "lsp",
      "nvim",
    ]);
    const withSpecs = getToolSpecs("root", noopMcpToolManager, withNvim);
    expect(withSpecs.map((s) => s.name)).toContain("nvim_lua");

    const withoutNvim: Set<ToolCapability> = new Set([
      "file-io",
      "shell",
      "threads",
      "lsp",
    ]);
    const withoutSpecs = getToolSpecs("root", noopMcpToolManager, withoutNvim);
    expect(withoutSpecs.map((s) => s.name)).not.toContain("nvim_lua");
  });

  it("works with subagent thread type", () => {
    const caps: Set<ToolCapability> = new Set(["file-io", "shell"]);
    const specs = getToolSpecs("subagent", noopMcpToolManager, caps);
    const names = specs.map((s) => s.name);
    expect(names).toContain("get_files");
    expect(names).toContain("bash_command");
    expect(names).toContain("edl");
    expect(names).not.toContain("hover");
    // yield_to_parent has no required capabilities
    expect(names).toContain("yield_to_parent");
  });
});

describe("tier-based spawn_subagents control", () => {
  it("leaf subagent does not get spawn_subagents", () => {
    const specs = getToolSpecs(
      "subagent",
      noopMcpToolManager,
      undefined,
      {},
      {
        tier: "leaf",
      },
    );
    const names = specs.map((s) => s.name);
    expect(names).not.toContain("spawn_subagents");
    expect(names).toContain("yield_to_parent");
  });

  it("thread subagent gets spawn_subagents", () => {
    const specs = getToolSpecs(
      "subagent",
      noopMcpToolManager,
      undefined,
      {},
      {
        tier: "thread",
      },
    );
    const names = specs.map((s) => s.name);
    expect(names).toContain("spawn_subagents");
    expect(names).toContain("yield_to_parent");
  });

  it("orchestrator subagent gets spawn_subagents", () => {
    const specs = getToolSpecs(
      "subagent",
      noopMcpToolManager,
      undefined,
      {},
      {
        tier: "orchestrator",
      },
    );
    const names = specs.map((s) => s.name);
    expect(names).toContain("spawn_subagents");
    expect(names).toContain("yield_to_parent");
  });

  it("leaf docker_root does not get spawn_subagents", () => {
    const specs = getToolSpecs(
      "docker_root",
      noopMcpToolManager,
      undefined,
      {},
      { tier: "leaf" },
    );
    const names = specs.map((s) => s.name);
    expect(names).not.toContain("spawn_subagents");
    expect(names).toContain("yield_to_parent");
  });

  it("thread docker_root gets spawn_subagents", () => {
    const specs = getToolSpecs(
      "docker_root",
      noopMcpToolManager,
      undefined,
      {},
      { tier: "thread" },
    );
    const names = specs.map((s) => s.name);
    expect(names).toContain("spawn_subagents");
    expect(names).toContain("yield_to_parent");
  });
});
