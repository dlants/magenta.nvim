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
  it("produces different descriptions for different skill lists", () => {
    const skills1 = [
      { name: "skill-a", description: "Does A", command: ["cmdA"] },
    ];
    const skills2 = [
      { name: "skill-b", description: "Does B", command: ["cmdB"] },
    ];
    const specs1 = getToolSpecs("root", noopMcpToolManager, undefined, skills1);
    const specs2 = getToolSpecs("root", noopMcpToolManager, undefined, skills2);
    const useSkill1 = specs1.find((s) => s.name === "use_skill");
    const useSkill2 = specs2.find((s) => s.name === "use_skill");
    expect(useSkill1).toBeDefined();
    expect(useSkill2).toBeDefined();
    expect(useSkill1!.description).toContain("skill-a");
    expect(useSkill1!.description).not.toContain("skill-b");
    expect(useSkill2!.description).toContain("skill-b");
    expect(useSkill2!.description).not.toContain("skill-a");
  });

  it("includes use_skill for docker_root thread type with skills", () => {
    const skills = [
      {
        name: "docker-skill",
        description: "Docker skill",
        command: ["docker-cmd"],
      },
    ];
    const specs = getToolSpecs(
      "docker_root",
      noopMcpToolManager,
      undefined,
      skills,
    );
    const names = specs.map((s) => s.name);
    expect(names).toContain("use_skill");
  });
});

describe("docker vs host skill isolation", () => {
  it("docker_root thread only gets docker skills", () => {
    const dockerSkills = [
      {
        name: "docker-skill",
        description: "A docker skill",
        command: ["docker-cmd"],
      },
    ];
    const specs = getToolSpecs(
      "docker_root",
      noopMcpToolManager,
      undefined,
      dockerSkills,
    );
    const useSkillSpec = specs.find((s) => s.name === "use_skill");
    expect(useSkillSpec).toBeDefined();
    expect(useSkillSpec!.description).toContain("docker-skill");
    expect(useSkillSpec!.description).not.toContain("host-skill");
  });

  it("root thread only gets host skills", () => {
    const hostSkills = [
      {
        name: "host-skill",
        description: "A host skill",
        command: ["host-cmd"],
      },
    ];
    const specs = getToolSpecs(
      "root",
      noopMcpToolManager,
      undefined,
      hostSkills,
    );
    const useSkillSpec = specs.find((s) => s.name === "use_skill");
    expect(useSkillSpec).toBeDefined();
    expect(useSkillSpec!.description).toContain("host-skill");
    expect(useSkillSpec!.description).not.toContain("docker-skill");
  });

  it("simulates thread.ts skill resolution for docker vs host", () => {
    const options = {
      toolSkills: {
        host: {
          "host-skill": {
            name: "host-skill",
            description: "Host only",
            command: ["host-cmd"],
          },
        },
        docker: {
          "docker-skill": {
            name: "docker-skill",
            description: "Docker only",
            command: ["docker-cmd"],
          },
        },
      },
    };

    // Simulate docker thread resolution (from thread.ts)
    const dockerSkills = Object.values(options.toolSkills.docker ?? {});
    const dockerSpecs = getToolSpecs(
      "docker_root",
      noopMcpToolManager,
      undefined,
      dockerSkills,
    );
    const dockerUseSkill = dockerSpecs.find((s) => s.name === "use_skill");
    expect(dockerUseSkill).toBeDefined();
    expect(dockerUseSkill!.description).toContain("docker-skill");
    expect(dockerUseSkill!.description).not.toContain("host-skill");

    // Simulate host thread resolution (from thread.ts)
    const hostSkills = Object.values(options.toolSkills.host ?? {});
    const hostSpecs = getToolSpecs(
      "root",
      noopMcpToolManager,
      undefined,
      hostSkills,
    );
    const hostUseSkill = hostSpecs.find((s) => s.name === "use_skill");
    expect(hostUseSkill).toBeDefined();
    expect(hostUseSkill!.description).toContain("host-skill");
    expect(hostUseSkill!.description).not.toContain("docker-skill");
  });
});
