import type {
  FileIO,
  GitClient,
  LspClient,
  LuaExecutor,
  ThreadId,
  ToolCapability,
} from "@magenta/core";
import type { SandboxViolationHandler } from "./capabilities/sandbox-violation-handler.ts";
import type { Shell } from "./capabilities/shell.ts";
import type { Sandbox } from "./sandbox-manager.ts";
import type { HomeDir, NvimCwd } from "./utils/files.ts";

export type EnvironmentConfig =
  | { type: "local"; cwd?: NvimCwd }
  | { type: "docker"; container: string; cwd: string };

export interface Environment {
  fileIO: FileIO;
  shell: Shell;
  gitClient: GitClient;
  sandboxViolationHandler?: SandboxViolationHandler | undefined;
  lspClient: LspClient;
  luaExecutor?: LuaExecutor | undefined;
  cwd: NvimCwd;
  homeDir: HomeDir;
  availableCapabilities: Set<ToolCapability>;
  environmentConfig: EnvironmentConfig;
}

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { DockerFileIO } from "./capabilities/docker-file-io.ts";
import { DockerShell } from "./capabilities/docker-shell.ts";
import { DockerGitClient, LocalGitClient } from "./capabilities/git-client.ts";
import type { Lsp } from "./capabilities/lsp.ts";
import { NvimLspClient } from "./capabilities/lsp-client-adapter.ts";
import { NoopLspClient } from "./capabilities/noop-lsp-client.ts";
import { NvimLuaExecutor } from "./capabilities/nvim-lua-executor.ts";
import { SandboxFileIO } from "./capabilities/sandbox-file-io.ts";
import { SandboxShell } from "./capabilities/sandbox-shell.ts";
import { SandboxViolationHandler as SandboxViolationHandlerImpl } from "./capabilities/sandbox-violation-handler.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import type { MagentaOptions } from "./options.ts";

export function createLocalEnvironment({
  nvim,
  lsp,
  cwd,
  homeDir,
  getOptions,
  threadId,
  sandbox,
  onPendingChange,
  isBypassed,
}: {
  nvim: Nvim;
  lsp: Lsp;
  cwd: NvimCwd;
  homeDir: HomeDir;
  getOptions: () => MagentaOptions;
  threadId: ThreadId;
  sandbox: Sandbox;
  onPendingChange: () => void;
  isBypassed: () => boolean;
}): Environment {
  const violationHandler = new SandboxViolationHandlerImpl(onPendingChange);

  const sandboxFileIO = new SandboxFileIO(
    { nvim, cwd, homeDir },
    sandbox,
    (absPath) => violationHandler.promptForWriteApproval(absPath),
    isBypassed,
  );

  const sandboxShell = new SandboxShell(
    { cwd, homeDir, threadId, getOptions, isBypassed },
    sandbox,
    violationHandler,
  );

  const lspClient = new NvimLspClient(lsp, nvim, cwd, homeDir);
  const luaExecutor = new NvimLuaExecutor(nvim);

  return {
    fileIO: sandboxFileIO,
    shell: sandboxShell,
    gitClient: new LocalGitClient(cwd),
    sandboxViolationHandler: violationHandler,
    lspClient,
    luaExecutor,
    cwd,
    homeDir,
    availableCapabilities: new Set([
      "lsp",
      "shell",
      "threads",
      "file-io",
      "scripts",
      "nvim",
    ]),
    environmentConfig: { type: "local" },
  };
}
const execFile = promisify(execFileCb);

export async function createDockerEnvironment({
  container,
  cwd: cwdParam,
  threadId,
}: {
  container: string;
  cwd?: string;
  threadId: ThreadId;
}): Promise<Environment> {
  const resolvedCwd: string =
    cwdParam ??
    (await execFile("docker", ["exec", container, "pwd"]).then((r) =>
      r.stdout.trim(),
    ));
  const resolvedHome = await execFile("docker", [
    "exec",
    container,
    "sh",
    "-c",
    "echo $HOME",
  ]).then((r) => r.stdout.trim());

  const fileIO = new DockerFileIO({ container });
  const shell = new DockerShell({ container, cwd: resolvedCwd, threadId });
  const lspClient = new NoopLspClient();

  return {
    fileIO,
    shell,
    gitClient: new DockerGitClient(container, resolvedCwd),
    sandboxViolationHandler: undefined,
    lspClient,
    cwd: resolvedCwd as NvimCwd,
    homeDir: resolvedHome as HomeDir,
    availableCapabilities: new Set(["file-io", "shell", "threads"]),
    environmentConfig: { type: "docker", container, cwd: resolvedCwd },
  };
}
