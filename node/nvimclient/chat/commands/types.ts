import type { ProviderMessageContent } from "../../providers/provider-types.ts";

export interface MessageContext {
  nvim: import("../../nvim/nvim-node/index.ts").Nvim;
  cwd: import("../../utils/files.ts").NvimCwd;
  homeDir: import("../../utils/files.ts").HomeDir;
  fileSupervisor: import("@magenta/server").FileSupervisor;
  options: import("../../options.ts").MagentaOptions;
}

export interface Command {
  name: string;
  description?: string;
  // Optional persistent system reminder activated when this command matches.
  systemReminder?: string;
  // Pattern to match the command (e.g., /^@nedit\b/ for simple commands, /^@file:(.+)/ for parameterized)
  pattern: RegExp;
  execute(
    match: RegExpMatchArray,
    context: MessageContext,
  ): Promise<ProviderMessageContent[]>;
}

export interface CommandMatch {
  command: Command;
  match: RegExpMatchArray;
  startIndex: number;
  endIndex: number;
}
