import { describe, expect, it } from "vitest";
import type { HomeDir, ProjectDir } from "../utils/files.ts";
import { normalizeThreadRequest } from "./script-manager.ts";

const base = {
  projectDir: "/session" as ProjectDir,
  homeDir: "/home/user" as HomeDir,
};
const createThread = (options: Record<string, unknown>) =>
  normalizeThreadRequest(
    {
      type: "create-thread",
      requestId: 1,
      prompt: "p",
      yieldSchema: {},
      options,
    } as Parameters<typeof normalizeThreadRequest>[0],
    base,
  );

describe("normalizeThreadRequest contextFiles", () => {
  it("resolves against the session dir when no projectDir is given", () => {
    expect(
      createThread({ contextFiles: ["a.ts", "~/b.ts", "/abs/c.ts"] })
        .contextFiles,
    ).toEqual(["/session/a.ts", "/home/user/b.ts", "/abs/c.ts"]);
  });
  it("resolves against options.projectDir when given", () => {
    expect(
      createThread({ projectDir: "/other", contextFiles: ["a.ts", "~/b.ts"] })
        .contextFiles,
    ).toEqual(["/other/a.ts", "/home/user/b.ts"]);
  });
});
describe("normalizeThreadRequest projectDir", () => {
  it("accepts absolute and ~/ paths", () => {
    expect(createThread({ projectDir: "/other" }).projectDir).toBe("/other");
    expect(createThread({ projectDir: "~/proj" }).projectDir).toBe(
      "/home/user/proj",
    );
  });
  it("rejects relative paths", () => {
    expect(() => createThread({ projectDir: "sub" })).toThrow(
      /must be an absolute path/,
    );
  });
});
