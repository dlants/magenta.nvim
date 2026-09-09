import { describe, expect, it } from "vitest";
import { getToolSpecs, type MCPToolManager } from "./toolManager.ts";

const mockMcpToolManager: MCPToolManager = {
  getToolSpecs: () => [],
};

describe("docker_root tool specs", () => {
  it("includes root tools plus yield_to_parent", () => {
    const specs = getToolSpecs("docker_root", mockMcpToolManager);
    const names = specs.map((s) => s.name);

    expect(names).toContain("get_files");
    expect(names).toContain("bash_command");
    expect(names).not.toContain("spawn_subagents");
    expect(names).toContain("edl");
    expect(names).toContain("yield_to_parent");
  });

  it("excludes lsp tools when those capabilities are missing", () => {
    const dockerCapabilities = new Set<"lsp" | "shell" | "threads" | "file-io">(
      ["file-io", "shell", "threads"],
    );

    const specs = getToolSpecs(
      "docker_root",
      mockMcpToolManager,
      dockerCapabilities,
    );
    const names = specs.map((s) => s.name);

    expect(names).not.toContain("hover");
    expect(names).not.toContain("find_references");
    expect(names).toContain("get_files");
    expect(names).toContain("bash_command");
    expect(names).toContain("yield_to_parent");
  });
});
