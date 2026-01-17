import { test, expect, describe } from "vitest";
import { canReadFile } from "./permissions.ts";
import type { AbsFilePath, NvimCwd } from "../utils/files.ts";
import type { MagentaOptions } from "../options.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { Gitignore } from "./util.ts";

const mockNvim = {
  logger: {
    error: () => {},
  },
} as unknown as Nvim;

const mockGitignore = {
  ignores: () => false,
} as unknown as Gitignore;

const defaultOptions: MagentaOptions = {
  skillsPaths: [],
  getFileAutoAllowGlobs: [],
} as unknown as MagentaOptions;

describe("canReadFile", () => {
  test("returns true for files in /tmp/magenta directory", async () => {
    const result = await canReadFile(
      "/tmp/magenta/threads/abc123/tools/tool_1/bashCommand.log" as AbsFilePath,
      {
        cwd: "/home/user/project" as NvimCwd,
        nvim: mockNvim,
        options: defaultOptions,
        gitignore: mockGitignore,
      },
    );
    expect(result).toBe(true);
  });

  test("returns false for other /tmp files (requires confirmation)", async () => {
    const result = await canReadFile("/tmp/other/file.txt" as AbsFilePath, {
      cwd: "/home/user/project" as NvimCwd,
      nvim: mockNvim,
      options: defaultOptions,
      gitignore: mockGitignore,
    });
    expect(result).toBe(false);
  });

  test("returns true for files in project cwd", async () => {
    const result = await canReadFile(
      "/home/user/project/src/file.ts" as AbsFilePath,
      {
        cwd: "/home/user/project" as NvimCwd,
        nvim: mockNvim,
        options: defaultOptions,
        gitignore: mockGitignore,
      },
    );
    expect(result).toBe(true);
  });

  test("returns false for hidden files (requires confirmation)", async () => {
    const result = await canReadFile(
      "/home/user/project/.hidden/file.ts" as AbsFilePath,
      {
        cwd: "/home/user/project" as NvimCwd,
        nvim: mockNvim,
        options: defaultOptions,
        gitignore: mockGitignore,
      },
    );
    expect(result).toBe(false);
  });
});
