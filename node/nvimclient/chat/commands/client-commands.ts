import type { AgentInput, ClientCommandName } from "@magenta/server";
import { getQuickfixList, quickfixListToString } from "../../nvim/nvim.ts";
import type { Nvim } from "../../nvim/nvim-node/index.ts";
import { getDiagnostics } from "../../utils/diagnostics.ts";
import {
  AT_FILE_PATTERN,
  extractFileRefPath,
  formatFileRef,
  type HomeDir,
  type NvimCwd,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../../utils/files.ts";
import { getBuffersList } from "../../utils/listBuffers.ts";

export type ClientCommandContext = {
  nvim: Nvim;
  cwd: NvimCwd;
  homeDir: HomeDir;
};

const buffers = (context: ClientCommandContext) => getBuffersList(context.nvim);
const quickfix = async ({ nvim }: ClientCommandContext) =>
  quickfixListToString(await getQuickfixList(nvim), nvim);
const diagnostics = ({ nvim, cwd, homeDir }: ClientCommandContext) =>
  getDiagnostics(nvim, cwd, homeDir);

const CLIENT_COMMANDS: Record<
  ClientCommandName,
  { label: string; expand(context: ClientCommandContext): Promise<string> }
> = {
  buf: { label: "buffers list", expand: buffers },
  buffers: { label: "buffers list", expand: buffers },
  qf: { label: "quickfix list", expand: quickfix },
  quickfix: { label: "quickfix list", expand: quickfix },
  diag: { label: "diagnostics", expand: diagnostics },
  diagnostics: { label: "diagnostics", expand: diagnostics },
};
/** Answers the server's delivery-time request for a client-state command.
 * Failures reject, and the server turns them into an error block. */
export async function expandClientCommand(
  command: ClientCommandName,
  context: ClientCommandContext,
): Promise<AgentInput[]> {
  const { label, expand } = CLIENT_COMMANDS[command];
  return [
    { type: "text", text: `Current ${label}:\n${await expand(context)}` },
  ];
}

const AT_GIT_PATH_PATTERN = /@(diff|staged):(\S+)/g;
/** Rewrites every `@file:`, `@diff:` and `@staged:` ref to an absolute path against Neovim's cwd, since the server
 * has no working directory to resolve them against. */
export function absolutizeFileRefs(
  text: string,
  cwd: NvimCwd,
  homeDir: HomeDir,
): string {
  let result = "";
  let last = 0;
  for (const match of text.matchAll(AT_FILE_PATTERN)) {
    const path = extractFileRefPath(match) as UnresolvedFilePath;
    result += text.slice(last, match.index);
    result += formatFileRef(resolveFilePath(cwd, path, homeDir));
    last = match.index + match[0].length;
  }
  return (result + text.slice(last)).replace(
    AT_GIT_PATH_PATTERN,
    (_match, kind: string, path: string) =>
      `@${kind}:${resolveFilePath(cwd, path as UnresolvedFilePath, homeDir)}`,
  );
}
