import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { DockerFileIO } from "./capabilities/docker-file-io.ts";
import { DockerShell } from "./capabilities/docker-shell.ts";
import type { FileIO } from "./capabilities/file-io.ts";
import type { GitClient } from "./capabilities/git-client.ts";
import { DockerGitClient, LocalGitClient } from "./capabilities/git-clients.ts";
import type { LspClient } from "./capabilities/lsp-client.ts";
import type { LuaExecutor } from "./capabilities/lua-executor.ts";
import { SandboxFileIO } from "./capabilities/sandbox-file-io.ts";
import { SandboxShell } from "./capabilities/sandbox-shell.ts";
import type { SandboxViolationHandler } from "./capabilities/sandbox-violation-handler.ts";
import type { Shell } from "./capabilities/shell.ts";
import type { ThreadId } from "./chat-types.ts";
import type { Logger } from "./logger.ts";
import type { SandboxConfig } from "./sandbox-config.ts";
import type { Sandbox } from "./sandbox-manager.ts";
import type { ToolCapability } from "./tools/tool-registry.ts";
import {
  type AbsFilePath,
  type Cwd,
  type HomeDir,
  toCwd,
  toHomeDir,
} from "./utils/files.ts";
export type EnvironmentConfig =
  | { type: "local"; cwd?: Cwd }
  | { type: "docker"; container: string; cwd: string };

export interface Environment {
  fileIO: FileIO;
  shell: Shell;
  gitClient: GitClient;
  sandboxViolationHandler?: SandboxViolationHandler | undefined;
  /** Editor-backed; its presence is what offers the lsp tools. */
  lspClient?: LspClient | undefined;
  /** Editor-backed; its presence is what offers the nvim tools. */
  luaExecutor?: LuaExecutor | undefined;
  cwd: Cwd;
  homeDir: HomeDir;
  environmentConfig: EnvironmentConfig;
}
/** Derived from the environment's collaborators so capabilities and their dependencies cannot disagree. */
export function environmentCapabilities(env: Environment): Set<ToolCapability> {
  const caps = new Set<ToolCapability>(["file-io", "shell", "threads"]);
  if (env.environmentConfig.type === "local") caps.add("scripts");
  if (env.lspClient) caps.add("lsp");
  if (env.luaExecutor) caps.add("nvim");
  return caps;
}

export function createLocalEnvironment({
  logger,
  cwd,
  homeDir,
  getSandboxConfig,
  threadId,
  sandbox,
  approvals,
  isBypassed,
  getShellEnv,
  lspClient,
  luaExecutor,
  onFileWritten,
}: {
  logger: Logger;
  cwd: Cwd;
  homeDir: HomeDir;
  getSandboxConfig: () => SandboxConfig;
  threadId: ThreadId;
  sandbox: Sandbox;
  /** Session-owned; see `Session.approvalsFor`. */
  approvals: SandboxViolationHandler;
  isBypassed: () => boolean;
  getShellEnv?: () => Record<string, string>;
  /** Editor-backed; the lsp tools are only offered when supplied. */
  lspClient?: LspClient | undefined;
  /** Editor-backed; the nvim tools are only offered when supplied. */
  luaExecutor?: LuaExecutor | undefined;
  onFileWritten?: ((absPath: AbsFilePath) => Promise<void>) | undefined;
}): Environment {
  const violationHandler = approvals;
  const sandboxFileIO = new SandboxFileIO(
    { logger, cwd, homeDir },
    sandbox,
    (absPath) => violationHandler.promptForWriteApproval(absPath),
    isBypassed,
    onFileWritten,
  );
  const sandboxShell = new SandboxShell(
    {
      cwd,
      homeDir,
      threadId,
      getSandboxConfig,
      isBypassed,
      ...(getShellEnv ? { getEnv: getShellEnv } : {}),
    },
    sandbox,
    violationHandler,
  );
  return {
    fileIO: sandboxFileIO,
    shell: sandboxShell,
    gitClient: new LocalGitClient(cwd),
    sandboxViolationHandler: violationHandler,
    lspClient,
    luaExecutor,
    cwd,
    homeDir,
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

  return {
    fileIO,
    shell,
    gitClient: new DockerGitClient(container, resolvedCwd),
    sandboxViolationHandler: undefined,
    cwd: toCwd(resolvedCwd),
    homeDir: toHomeDir(resolvedHome),
    environmentConfig: { type: "docker", container, cwd: resolvedCwd },
  };
}
