import { describe, it, expect } from "vitest";
import { getToolSpecs } from "./toolManager.ts";
import type { ToolCapability } from "./tool-registry.ts";

const noopMcpToolManager = { getToolSpecs: () => [] };

describe("getToolSpecs capability filtering", () => {
  it("returns all tools for thread type when no capabilities filter provided", () => {
    const specs = getToolSpecs("root", noopMcpToolManager);
    const names = specs.map((s) => s.name);
    expect(names).toContain("hover");
    expect(names).toContain("bash_command");
    expect(names).toContain("diagnostics");
    expect(names).toContain("get_file");
  });

  it("excludes lsp tools when lsp capability is missing", () => {
    const caps: Set<ToolCapability> = new Set([
      "file-io",
      "shell",
      "diagnostics",
      "threads",
    ]);
    const specs = getToolSpecs("root", noopMcpToolManager, caps);
    const names = specs.map((s) => s.name);
    expect(names).not.toContain("hover");
    expect(names).not.toContain("find_references");
    expect(names).toContain("bash_command");
    expect(names).toContain("diagnostics");
    expect(names).toContain("get_file");
    expect(names).toContain("edl");
  });

  it("excludes diagnostics when diagnostics capability is missing", () => {
    const caps: Set<ToolCapability> = new Set([
      "file-io",
      "shell",
      "lsp",
      "threads",
    ]);
    const specs = getToolSpecs("root", noopMcpToolManager, caps);
    const names = specs.map((s) => s.name);
    expect(names).not.toContain("diagnostics");
    expect(names).toContain("hover");
  });

  it("includes tools with no required capabilities regardless of filter", () => {
    const caps: Set<ToolCapability> = new Set(["file-io"]);
    const specs = getToolSpecs("root", noopMcpToolManager, caps);
    const names = specs.map((s) => s.name);
    expect(names).toContain("get_file");
    expect(names).toContain("edl");
    expect(names).not.toContain("bash_command");
    expect(names).not.toContain("spawn_subagent");
  });

  it("works with subagent thread type", () => {
    const caps: Set<ToolCapability> = new Set(["file-io", "shell"]);
    const specs = getToolSpecs("subagent_default", noopMcpToolManager, caps);
    const names = specs.map((s) => s.name);
    expect(names).toContain("get_file");
    expect(names).toContain("bash_command");
    expect(names).toContain("edl");
    expect(names).not.toContain("hover");
    expect(names).not.toContain("diagnostics");
    // yield_to_parent has no required capabilities
    expect(names).toContain("yield_to_parent");
  });
});
