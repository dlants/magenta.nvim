import type { FileIO } from "../../capabilities/file-io.ts";
import type { Logger } from "../../logger.ts";
import type { AgentInput } from "../../providers/provider-types.ts";
import type { ContextFileAccess } from "../../thread.ts";
import type { HomeDir, ProjectDir } from "../../utils/files.ts";

export interface MessageContext {
  projectDir: ProjectDir;
  homeDir: HomeDir;
  /** The thread's (possibly sandboxed or docker) fileIO. */
  fileIO: FileIO;
  fileSupervisor: ContextFileAccess;
  logger: Logger;
}

export type CustomCommand = {
  name: string;
  text: string;
  description?: string;
  systemReminder?: string;
};

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
  ): Promise<AgentInput[]>;
}

export interface CommandMatch {
  command: Command;
  match: RegExpMatchArray;
  startIndex: number;
  endIndex: number;
}
