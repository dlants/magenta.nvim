import { test, expect, describe } from "vitest";
import {
  isCommandAllowedByConfig,
  BUILTIN_COMMAND_PERMISSIONS,
} from "./permissions.ts";
import type { NvimCwd } from "../../utils/files.ts";
import type { Gitignore } from "../util.ts";

const mockGitignore = {
  ignores: () => false,
} as unknown as Gitignore;

describe("isCommandAllowedByConfig with magenta temp files", () => {
  test("allows cat on magenta temp files", () => {
    const result = isCommandAllowedByConfig(
      "cat /tmp/magenta/threads/abc123/tools/tool_1/bashCommand.log",
      BUILTIN_COMMAND_PERMISSIONS,
      {
        cwd: "/home/user/project" as NvimCwd,
        gitignore: mockGitignore,
      },
    );
    expect(result.allowed).toBe(true);
  });

  test("allows head on magenta temp files", () => {
    const result = isCommandAllowedByConfig(
      "head -20 /tmp/magenta/threads/abc123/tools/tool_1/bashCommand.log",
      BUILTIN_COMMAND_PERMISSIONS,
      {
        cwd: "/home/user/project" as NvimCwd,
        gitignore: mockGitignore,
      },
    );
    expect(result.allowed).toBe(true);
  });

  test("allows tail on magenta temp files", () => {
    const result = isCommandAllowedByConfig(
      "tail -50 /tmp/magenta/threads/abc123/tools/tool_1/bashCommand.log",
      BUILTIN_COMMAND_PERMISSIONS,
      {
        cwd: "/home/user/project" as NvimCwd,
        gitignore: mockGitignore,
      },
    );
    expect(result.allowed).toBe(true);
  });

  test("disallows cat on other /tmp files", () => {
    const result = isCommandAllowedByConfig(
      "cat /tmp/other/file.txt",
      BUILTIN_COMMAND_PERMISSIONS,
      {
        cwd: "/home/user/project" as NvimCwd,
        gitignore: mockGitignore,
      },
    );
    expect(result.allowed).toBe(false);
  });

  test("allows grep on magenta temp files", () => {
    const result = isCommandAllowedByConfig(
      "grep error /tmp/magenta/threads/abc123/tools/tool_1/bashCommand.log",
      BUILTIN_COMMAND_PERMISSIONS,
      {
        cwd: "/home/user/project" as NvimCwd,
        gitignore: mockGitignore,
      },
    );
    expect(result.allowed).toBe(true);
  });
});
