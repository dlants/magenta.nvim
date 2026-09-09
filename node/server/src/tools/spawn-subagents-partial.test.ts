import { describe, expect, it } from "vitest";
import { parsePartialSpawnSubagentsInput } from "./spawn-subagents.ts";

const FULL_INPUT = JSON.stringify({
  sharedPrompt: 'shared prompt with\nnewline and "quote"',
  sharedContextFiles: ["a.ts", "b.ts"],
  agents: [
    {
      agentType: "subagent",
      environment: "docker",
      dockerfile: "Dockerfile",
      directory: ".",
      workspacePath: "/workspace",
      prompt: "do the thing",
      contextFiles: ["x.ts", "y.ts"],
    },
    {
      prompt: "second agent",
    },
  ],
});

describe("parsePartialSpawnSubagentsInput", () => {
  it("parses the full input", () => {
    const r = parsePartialSpawnSubagentsInput(FULL_INPUT);
    expect(r.sharedPrompt).toBe('shared prompt with\nnewline and "quote"');
    expect(r.sharedContextFiles).toEqual(["a.ts", "b.ts"]);
    expect(r.agents).toHaveLength(2);
    expect(r.agents[0]).toEqual({
      agentType: "subagent",
      environment: "docker",
      dockerfile: "Dockerfile",
      directory: ".",
      workspacePath: "/workspace",
      prompt: "do the thing",
      contextFiles: ["x.ts", "y.ts"],
    });
    expect(r.agents[1]).toEqual({ prompt: "second agent" });
  });

  it("never throws and is monotonic across all prefixes", () => {
    const full = parsePartialSpawnSubagentsInput(FULL_INPUT);
    for (let i = 0; i <= FULL_INPUT.length; i++) {
      const prefix = FULL_INPUT.slice(0, i);
      expect(() => parsePartialSpawnSubagentsInput(prefix)).not.toThrow();
      const r = parsePartialSpawnSubagentsInput(prefix);
      expect(Array.isArray(r.agents)).toBe(true);
      // shared context files, once fully present, are a prefix of the final
      if (r.sharedContextFiles) {
        for (let j = 0; j < r.sharedContextFiles.length - 1; j++) {
          expect(r.sharedContextFiles[j]).toBe(full.sharedContextFiles![j]);
        }
      }
    }
  });

  it("returns empty-ish results for trivial prefixes", () => {
    expect(parsePartialSpawnSubagentsInput("")).toEqual({ agents: [] });
    expect(parsePartialSpawnSubagentsInput("{")).toEqual({ agents: [] });
    expect(parsePartialSpawnSubagentsInput('{"shared')).toEqual({ agents: [] });
  });

  it("returns trailing partial string token for a truncated prompt", () => {
    const json = '{"agents":[{"prompt":"hello wor';
    const r = parsePartialSpawnSubagentsInput(json);
    expect(r.agents[0].prompt).toBe("hello wor");
  });

  it("returns parsed-so-far contextFiles with trailing partial element", () => {
    const json = '{"agents":[{"contextFiles":["done.ts","partial';
    const r = parsePartialSpawnSubagentsInput(json);
    expect(r.agents[0].contextFiles).toEqual(["done.ts", "partial"]);
  });

  it("decodes escapes including a truncated escape at end", () => {
    expect(
      parsePartialSpawnSubagentsInput('{"sharedPrompt":"a\\nb\\\\c\\"d')
        .sharedPrompt,
    ).toBe('a\nb\\c"d');
    expect(
      parsePartialSpawnSubagentsInput('{"sharedPrompt":"abc\\').sharedPrompt,
    ).toBe("abc");
    expect(
      parsePartialSpawnSubagentsInput('{"sharedPrompt":"abc\\u00').sharedPrompt,
    ).toBe("abc");
    expect(
      parsePartialSpawnSubagentsInput('{"sharedPrompt":"abc\\u0041"')
        .sharedPrompt,
    ).toBe("abcA");
  });
});
