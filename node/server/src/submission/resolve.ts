import type { FileIO } from "../capabilities/file-io.ts";
import type { Logger } from "../logger.ts";
import type { AgentInput } from "../providers/provider-types.ts";
import type { ContextFileAccess } from "../thread.ts";
import type { Aborted } from "../thread-api.ts";
import type { HomeDir, ProjectDir } from "../utils/files.ts";
import { type AwaitClient, clientCommands } from "./commands/client.ts";
import { CommandRegistry } from "./commands/registry.ts";
import type { CustomCommand } from "./commands/types.ts";
import {
  type PendingMessage,
  parseCompact,
  type ResolvedSubmission,
} from "./index.ts";

export type ResolveSubmissionContext = {
  projectDir: ProjectDir;
  homeDir: HomeDir;
  fileIO: FileIO;
  logger: Logger;
  customCommands: CustomCommand[];
  getContextFiles: () => ContextFileAccess;
  /** A compact thread has no compactor, so `@compact` is ordinary text. */
  canCompact: boolean;
  /** The client attached at delivery answers `@buf`, `@qf`, `@diag`. */
  awaitClient: AwaitClient;
};

/** Expands the commands of a raw message at delivery time. */
export async function resolveSubmission(
  message: PendingMessage,
  context: ResolveSubmissionContext,
  abandoned: Promise<Aborted>,
): Promise<ResolvedSubmission> {
  const { compact, rest } = context.canCompact
    ? parseCompact(message)
    : { compact: false, rest: message };
  const registry = new CommandRegistry();
  for (const custom of context.customCommands) {
    registry.registerCustomCommand(custom);
  }
  for (const command of clientCommands(context.awaitClient, abandoned)) {
    registry.registerCommand(command);
  }
  const { processedText, additionalContent, reminders } =
    await registry.processMessage(rest, {
      projectDir: context.projectDir,
      homeDir: context.homeDir,
      fileIO: context.fileIO,
      logger: context.logger,
      fileSupervisor: context.getContextFiles(),
    });
  const content: AgentInput[] = [{ type: "text", text: processedText }];
  for (const extra of additionalContent) {
    if (
      extra.type === "text" ||
      extra.type === "image" ||
      extra.type === "document"
    ) {
      content.push(extra);
    }
  }
  const prompt = { content, reminders };
  return compact ? { type: "compact", prompt } : { type: "send", prompt };
}
