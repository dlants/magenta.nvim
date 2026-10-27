import type { AgentInput } from "../../providers/provider-types.ts";
import type { UnresolvedFilePath } from "../../utils/files.ts";
import {
  AT_FILE_PATTERN,
  detectFileTypeViaFileIO,
  extractFileRefPath,
  resolveAbsPath,
} from "../../utils/files.ts";
import type { Command } from "./types.ts";

export const fileCommand: Command = {
  name: "@file:",
  pattern: AT_FILE_PATTERN,
  async execute(match, context): Promise<AgentInput[]> {
    const filePath = extractFileRefPath(match) as UnresolvedFilePath;
    try {
      const resolved = resolveAbsPath(filePath, context.homeDir);
      if (resolved.status === "error") throw new Error(resolved.error);
      const absFilePath = resolved.value;
      const fileTypeInfo = await detectFileTypeViaFileIO(
        absFilePath,
        context.fileIO,
      );

      if (!fileTypeInfo) {
        throw new Error(`File ${filePath} does not exist`);
      }

      context.fileSupervisor.addFileContext(absFilePath, fileTypeInfo);

      return []; // File context is handled by fileSupervisor
    } catch (error) {
      context.logger.error(
        `Failed to add file to context for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [
        {
          type: "text",
          text: `Error adding file to context for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }
  },
};
