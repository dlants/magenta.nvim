import { describe, expect, it } from "vitest";
import type { ToolSkillConfig } from "../provider-options.ts";
import { getSpec, validateInput } from "./useSkill.ts";

describe("validateInput", () => {
  it("accepts valid input with skill and input", () => {
    const result = validateInput({ skill: "greet", input: { name: "world" } });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.skill).toBe("greet");
      expect(result.value.input).toEqual({ name: "world" });
    }
  });

  it("accepts skill without input (docs mode)", () => {
    const result = validateInput({ skill: "greet" });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.skill).toBe("greet");
      expect(result.value.input).toBeUndefined();
    }
  });

  it("rejects missing skill", () => {
    const result = validateInput({ input: {} });
    expect(result.status).toBe("error");
  });

  it("rejects empty skill name", () => {
    const result = validateInput({ skill: "" });
    expect(result.status).toBe("error");
  });

  it("rejects non-object input", () => {
    const result = validateInput({ skill: "greet", input: "bad" });
    expect(result.status).toBe("error");
  });
});

describe("getSpec", () => {
  it("includes skill names in description", () => {
    const skills: ToolSkillConfig[] = [
      { name: "deploy", description: "Deploy the app", command: ["deploy"] },
      { name: "test", description: "Run tests", command: ["test"] },
    ];
    const spec = getSpec(skills);
    expect(spec.name).toBe("use_skill");
    expect(spec.description).toContain("deploy");
    expect(spec.description).toContain("Deploy the app");
    expect(spec.description).toContain("test");
    expect(spec.description).toContain("Run tests");
  });
});
