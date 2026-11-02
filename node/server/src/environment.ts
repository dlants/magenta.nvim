import type { FileIO } from "./capabilities/file-io.ts";
import type { GitClient } from "./capabilities/git-client.ts";
import { LocalGitClient } from "./capabilities/git-clients.ts";
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
  type HomeDir,
  type ProjectDir,
  toProjectDir,
} from "./utils/files.ts";
export type EnvironmentConfig = { type: "local"; projectDir?: ProjectDir };

export interface Environment {
  fileIO: FileIO;
  shell: Shell;
  gitClient: GitClient;
  sandboxViolationHandler?: SandboxViolationHandler | undefined;
  /** Editor-backed; its presence is what offers the lsp tools. */
  lspClient?: LspClient | undefined;
  /** Editor-backed; its presence is what offers the nvim tools. */
  luaExecutor?: LuaExecutor | undefined;
  projectDir: ProjectDir;
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
  projectDir,
  homeDir,
  getSandboxConfig,
  threadId,
  sandbox,
  approvals,
  isBypassed,
  lspClient,
  luaExecutor,
  onFileWritten,
}: {
  logger: Logger;
  projectDir: ProjectDir;
  homeDir: HomeDir;
  getSandboxConfig: () => SandboxConfig;
  threadId: ThreadId;
  sandbox: Sandbox;
  /** Session-owned; see `Session.approvalsFor`. */
  approvals: SandboxViolationHandler;
  isBypassed: () => boolean;
  /** Editor-backed; the lsp tools are only offered when supplied. */
  lspClient?: LspClient | undefined;
  /** Editor-backed; the nvim tools are only offered when supplied. */
  luaExecutor?: LuaExecutor | undefined;
  onFileWritten?: ((absPath: AbsFilePath) => Promise<void>) | undefined;
}): Environment {
  const violationHandler = approvals;
  const sandboxFileIO = new SandboxFileIO(
    { logger, projectDir, homeDir },
    sandbox,
    (absPath) => violationHandler.promptForWriteApproval(absPath),
    isBypassed,
    onFileWritten,
  );
  const sandboxShell = new SandboxShell(
    {
      projectDir: toProjectDir(projectDir),
      homeDir,
      threadId,
      getSandboxConfig,
      isBypassed,
    },
    sandbox,
    violationHandler,
  );
  return {
    fileIO: sandboxFileIO,
    shell: sandboxShell,
    gitClient: new LocalGitClient(),
    sandboxViolationHandler: violationHandler,
    lspClient,
    luaExecutor,
    projectDir,
    homeDir,
    environmentConfig: { type: "local" },
  };
}
