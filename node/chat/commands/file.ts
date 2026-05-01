import type { ProviderMessageContent } from "../../providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "@magenta/core";
import type { UnresolvedFilePath } from "../../utils/files.ts";
import {
  AT_FILE_PATTERN,
  detectFileType,
  extractFileRefPath,
  relativePath,
  resolveFilePath,
} from "../../utils/files.ts";
import type { Command } from "./types.ts";

export const fileCommand: Command = {
  name: "@file:",
  pattern: AT_FILE_PATTERN,
  async execute(match, context): Promise<ProviderMessageContent[]> {
    const filePath = extractFileRefPath(match) as UnresolvedFilePath;
    try {
      const absFilePath = resolveFilePath(
        context.cwd,
        filePath,
        context.homeDir,
      );
      const relFilePath = relativePath(
        context.cwd,
        absFilePath,
        context.homeDir,
      );
      const fileTypeInfo = await detectFileType(absFilePath);

      if (!fileTypeInfo) {
        throw new Error(`File ${filePath} does not exist`);
      }

      context.contextManager.addFileContext(
        absFilePath,
        relFilePath,
        fileTypeInfo,
      );

      return []; // File context is handled by contextManager
    } catch (error) {
      context.nvim.logger.error(
        `Failed to add file to context for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [
        {
          type: "text",
          text: `Error adding file to context for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ];
    }
  },
};
