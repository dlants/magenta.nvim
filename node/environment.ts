import type { FileIO, LspClient, DiagnosticsProvider } from "@magenta/core";
import type { Shell } from "./capabilities/shell.ts";
import type { PermissionCheckingFileIO } from "./capabilities/permission-file-io.ts";
import type { PermissionCheckingShell } from "./capabilities/permission-shell.ts";
import type { NvimCwd, HomeDir } from "./utils/files.ts";

export interface Environment {
  fileIO: FileIO;
  permissionFileIO?: PermissionCheckingFileIO | undefined;
  shell: Shell;
  permissionShell?: PermissionCheckingShell | undefined;
  lspClient: LspClient;
  diagnosticsProvider: DiagnosticsProvider;
  cwd: NvimCwd;
  homeDir: HomeDir;
}
import { BufferAwareFileIO } from "./capabilities/buffer-file-io.ts";
import { PermissionCheckingFileIO as PermissionCheckingFileIOImpl } from "./capabilities/permission-file-io.ts";
import { BaseShell } from "./capabilities/base-shell.ts";
import { PermissionCheckingShell as PermissionCheckingShellImpl } from "./capabilities/permission-shell.ts";
import { NvimLspClient } from "./capabilities/lsp-client-adapter.ts";
import { getDiagnostics } from "./utils/diagnostics.ts";
import type { Nvim } from "./nvim/nvim-node/index.ts";
import type { Lsp } from "./capabilities/lsp.ts";
import type { BufferTracker } from "./buffer-tracker.ts";
import type { MagentaOptions } from "./options.ts";
import type { ThreadId } from "./chat/types.ts";

export function createLocalEnvironment({
  nvim,
  lsp,
  bufferTracker,
  cwd,
  homeDir,
  options,
  threadId,
  rememberedCommands,
  onPendingChange,
}: {
  nvim: Nvim;
  lsp: Lsp;
  bufferTracker: BufferTracker;
  cwd: NvimCwd;
  homeDir: HomeDir;
  options: MagentaOptions;
  threadId: ThreadId;
  rememberedCommands: Set<string>;
  onPendingChange: () => void;
}): Environment {
  const bufferFileIO = new BufferAwareFileIO({
    nvim,
    bufferTracker,
    cwd,
    homeDir,
  });
  const permissionFileIO = new PermissionCheckingFileIOImpl(
    bufferFileIO,
    { cwd, homeDir, options, nvim },
    onPendingChange,
  );

  const baseShell = new BaseShell({ cwd, threadId });
  const permissionShell = new PermissionCheckingShellImpl(
    baseShell,
    { cwd, homeDir, options, nvim, rememberedCommands },
    onPendingChange,
  );

  const lspClient = new NvimLspClient(lsp, nvim, cwd, homeDir);
  const diagnosticsProvider = {
    getDiagnostics: () => getDiagnostics(nvim, cwd, homeDir),
  };

  return {
    fileIO: permissionFileIO,
    permissionFileIO,
    shell: permissionShell,
    permissionShell,
    lspClient,
    diagnosticsProvider,
    cwd,
    homeDir,
  };
}
