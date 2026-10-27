import { describe, expect, it } from "vitest";
import type { Cwd, HomeDir } from "../utils/files.ts";
import { normalizeThreadRequest } from "./script-manager.ts";

const base = { cwd: "/session" as Cwd, homeDir: "/home/user" as HomeDir };
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
  it("resolves against the session dir when no cwd is given", () => {
    expect(
      createThread({ contextFiles: ["a.ts", "~/b.ts", "/abs/c.ts"] })
        .contextFiles,
    ).toEqual(["/session/a.ts", "/home/user/b.ts", "/abs/c.ts"]);
  });
  it("resolves against options.cwd when given", () => {
    expect(
      createThread({ cwd: "/other", contextFiles: ["a.ts", "~/b.ts"] })
        .contextFiles,
    ).toEqual(["/other/a.ts", "/home/user/b.ts"]);
  });
});
