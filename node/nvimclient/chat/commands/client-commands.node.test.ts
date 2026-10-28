import { describe, expect, it } from "vitest";
import type { Nvim } from "../../nvim/nvim-node/index.ts";
import type { HomeDir, NvimCwd } from "../../utils/files.ts";
import { absolutizeFileRefs, expandClientCommand } from "./client-commands.ts";

const cwd = "/proj" as NvimCwd;
const homeDir = "/home/me" as HomeDir;

describe("absolutizeFileRefs", () => {
  it("resolves relative and ~ paths, leaves absolute ones", () => {
    expect(
      absolutizeFileRefs(
        "see @file:a.ts and @file:~/b.ts and @file:/abs/c.ts end",
        cwd,
        homeDir,
      ),
    ).toBe(
      "see @file:/proj/a.ts and @file:/home/me/b.ts and @file:/abs/c.ts end",
    );
  });
});

describe("absolutizeFileRefs git refs", () => {
  it("absolutizes @diff: and @staged: paths", () => {
    expect(
      absolutizeFileRefs(
        "@diff:src/a.ts @staged:/abs/b.ts @diff:~/c.ts @file:d.ts @staged:e.ts",
        cwd,
        homeDir,
      ),
    ).toBe(
      "@diff:/proj/src/a.ts @staged:/abs/b.ts @diff:/home/me/c.ts @file:/proj/d.ts @staged:/proj/e.ts",
    );
  });
});
describe("expandClientCommand", () => {
  it("rejects when the editor read fails, for the server to report", async () => {
    const nvim = {
      call: () => Promise.reject(new Error("boom")),
    } as unknown as Nvim;
    await expect(
      expandClientCommand("buf", { nvim, cwd, homeDir }),
    ).rejects.toThrow("boom");
  });
});
