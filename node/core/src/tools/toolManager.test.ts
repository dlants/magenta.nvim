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

describe("use_skill conditional inclusion", () => {
  it("excludes use_skill when no toolSkills provided", () => {
    const specs = getToolSpecs("root", noopMcpToolManager);
    const names = specs.map((s) => s.name);
    expect(names).not.toContain("use_skill");
  });

  it("excludes use_skill when toolSkills is empty array", () => {
    const specs = getToolSpecs("root", noopMcpToolManager, undefined, []);
    const names = specs.map((s) => s.name);
    expect(names).not.toContain("use_skill");
  });

  it("includes use_skill when toolSkills are provided", () => {
    const skills = [
      { name: "test-skill", description: "A test skill", command: ["echo"] },
    ];
    const specs = getToolSpecs("root", noopMcpToolManager, undefined, skills);
    const names = specs.map((s) => s.name);
    expect(names).toContain("use_skill");
  });

  it("uses dynamic description with skill names", () => {
    const skills = [
      { name: "my-skill", description: "Does things", command: ["cmd"] },
    ];
    const specs = getToolSpecs("root", noopMcpToolManager, undefined, skills);
    const useSkillSpec = specs.find((s) => s.name === "use_skill");
    expect(useSkillSpec).toBeDefined();
    expect(useSkillSpec!.description).toContain("my-skill");
    expect(useSkillSpec!.description).toContain("Does things");
  });

  it("excludes use_skill in compact thread type even with skills", () => {
    const skills = [
      { name: "test-skill", description: "A test skill", command: ["echo"] },
    ];
    const specs = getToolSpecs(
      "compact",
      noopMcpToolManager,
      undefined,
      skills,
    );
    const names = specs.map((s) => s.name);
    expect(names).not.toContain("use_skill");
  });
});
describe("conductor thread type", () => {
  it("returns same tools as root (CHAT_STATIC_TOOL_NAMES)", () => {
    const conductorSpecs = getToolSpecs("conductor", noopMcpToolManager);
    const rootSpecs = getToolSpecs("root", noopMcpToolManager);
    const conductorNames = conductorSpecs.map((s) => s.name);
    const rootNames = rootSpecs.map((s) => s.name);
    expect(conductorNames).toEqual(rootNames);
    expect(conductorNames).not.toContain("yield_to_parent");
    expect(conductorNames).toContain("spawn_subagent");
  });
});
