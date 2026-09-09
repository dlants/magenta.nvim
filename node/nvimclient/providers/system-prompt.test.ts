import { FsFileIO, formatSystemInfo } from "@magenta/server";
import { expect, it } from "vitest";
import { withDriver } from "../test/preamble.ts";
import { buildSystemInfo, createSystemPrompt } from "./system-prompt.ts";

it("applies systemInfoOverrides when building system info", async () => {
  await withDriver({}, async (driver) => {
    const systemInfo = await buildSystemInfo({
      nvim: driver.magenta.nvim,
      cwd: driver.magenta.cwd,
      systemInfoOverrides: {
        platform: "linux (docker)",
        cwd: "/workspace" as typeof driver.magenta.cwd,
      },
    });

    const text = formatSystemInfo(systemInfo);
    expect(text).toContain("- Operating system: linux (docker)");
    expect(text).toContain("- Current working directory: /workspace");
  });
});

it("docker prompt mentions the docker environment", async () => {
  await withDriver({}, async (driver) => {
    const systemPrompt = await createSystemPrompt("docker_root", {
      nvim: driver.magenta.nvim,
      cwd: driver.magenta.cwd,
      options: driver.magenta.options,
      fileIO: new FsFileIO(),
      homeDir: driver.magenta.homeDir,
    });

    expect(systemPrompt).toContain("# Docker Environment");
  });
});

it("docker_root prompt mentions syncing and yield_to_parent", async () => {
  await withDriver({}, async (driver) => {
    const systemPrompt = await createSystemPrompt("docker_root", {
      nvim: driver.magenta.nvim,
      cwd: driver.magenta.cwd,
      options: driver.magenta.options,
      fileIO: new FsFileIO(),
      homeDir: driver.magenta.homeDir,
    });

    expect(systemPrompt).toContain("# Docker Environment");
    expect(systemPrompt).toContain("yield_to_parent");
    expect(systemPrompt).toContain("synced back");
    expect(systemPrompt).not.toContain("commit");
    expect(systemPrompt).not.toContain("worker branch");
  });
});

it("system info is not part of the cached system prompt", async () => {
  await withDriver({}, async (driver) => {
    const systemPrompt = await createSystemPrompt("root", {
      nvim: driver.magenta.nvim,
      cwd: driver.magenta.cwd,
      options: driver.magenta.options,
      fileIO: new FsFileIO(),
      homeDir: driver.magenta.homeDir,
    });

    expect(systemPrompt).not.toContain("# System Information");
    expect(systemPrompt).not.toContain("- Current time:");
  });
});

it("formats system information for the first user message", async () => {
  await withDriver({}, async (driver) => {
    const systemInfo = await buildSystemInfo({
      nvim: driver.magenta.nvim,
      cwd: driver.magenta.cwd,
    });

    const text = formatSystemInfo(systemInfo);
    expect(text).toContain("# System Information");
    expect(text).toContain("- Operating system:");
    expect(text).toContain("- Neovim version:");
    expect(text).toMatch(/- Operating system: (darwin|linux|win32)/);
    expect(text).toMatch(/- Current time: \w+ \w+ \d+ \d+ \d+:\d+:\d+ GMT/);
    expect(text).toContain(
      `- Current working directory: ${driver.magenta.cwd}`,
    );
  });
});
