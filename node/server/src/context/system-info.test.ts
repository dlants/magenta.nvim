import path from "node:path";
import { expect, it } from "vitest";
import { InMemoryFileIO } from "../edl/in-memory-file-io.ts";
import type { Logger } from "../logger.ts";
import {
  createSystemPrompt,
  formatSystemInfo,
} from "../providers/system-prompt.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import { buildSystemInfo } from "./system-info.ts";

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;
const cwd = "/project" as NvimCwd;
const promptCtx = {
  logger,
  cwd,
  options: {
    skillsPaths: [],
    agentsPaths: [path.resolve(import.meta.dirname, "../agents")],
  },
  fileIO: new InMemoryFileIO({}),
  homeDir: "/home" as HomeDir,
};

it("applies systemInfoOverrides when building system info", () => {
  const text = formatSystemInfo(
    buildSystemInfo({
      cwd,
      neovimVersion: "801",
      overrides: { platform: "linux (docker)", cwd: "/workspace" as NvimCwd },
    }),
  );
  expect(text).toContain("- Operating system: linux (docker)");
  expect(text).toContain("- Current working directory: /workspace");
});

it("docker_root prompt mentions docker, syncing and yield_to_parent", async () => {
  const systemPrompt = await createSystemPrompt("docker_root", promptCtx);
  expect(systemPrompt).toContain("# Docker Environment");
  expect(systemPrompt).toContain("yield_to_parent");
  expect(systemPrompt).toContain("synced back");
  expect(systemPrompt).not.toContain("commit");
  expect(systemPrompt).not.toContain("worker branch");
});

it("system info is not part of the cached system prompt", async () => {
  const systemPrompt = await createSystemPrompt("root", promptCtx);
  expect(systemPrompt).not.toContain("# System Information");
  expect(systemPrompt).not.toContain("- Current time:");
});

it("formats system information for the first user message", () => {
  const text = formatSystemInfo(buildSystemInfo({ cwd, neovimVersion: "801" }));
  expect(text).toContain("# System Information");
  expect(text).toContain("- Neovim version: 801");
  expect(text).toMatch(/- Operating system: (darwin|linux|win32)/);
  expect(text).toMatch(/- Current time: \w+ \w+ \d+ \d+ \d+:\d+:\d+ GMT/);
  expect(text).toContain("- Current working directory: /project");
});
