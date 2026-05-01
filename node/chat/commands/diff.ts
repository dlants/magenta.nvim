import { $, within } from "zx";
import type { ProviderMessageContent } from "../../providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "@magenta/core";
import type { NvimCwd, UnresolvedFilePath } from "../../utils/files.ts";
import type { Command } from "./types.ts";

async function getGitDiff(
  filePath: UnresolvedFilePath,
  cwd: NvimCwd,
): Promise<string> {
  try {
    const result = await within(async () => {
      $.cwd = cwd;
      return await $`git diff ${filePath}`;
    });
    return result.stdout || "(no unstaged changes)";
  } catch (error) {
    throw new Error(
      `Failed to get git diff: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function getStagedDiff(
  filePath: UnresolvedFilePath,
  cwd: NvimCwd,
): Promise<string> {
  try {
    const result = await within(async () => {
      $.cwd = cwd;
      return await $`git diff --staged ${filePath}`;
    });
    return result.stdout || "(no staged changes)";
  } catch (error) {
    throw new Error(
      `Failed to get staged diff: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const diffCommand: Command = {
  name: "@diff:",
  pattern: /@diff:(\S+)/g,
  async execute(match, context): Promise<ProviderMessageContent[]> {
    const filePath = match[1] as UnresolvedFilePath;
    try {
      const diffContent = await getGitDiff(filePath, context.cwd);
      return [
        {
          type: "text",
          text: `Git diff for \`${filePath}\`:\n\`\`\`diff\n${diffContent}\n\`\`\``,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ];
    } catch (error) {
      context.nvim.logger.error(
        `Failed to fetch git diff for \`${filePath}\`: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [
        {
          type: "text",
          text: `Error fetching git diff for \`${filePath}\`: ${error instanceof Error ? error.message : String(error)}`,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ];
    }
  },
};

export const stagedCommand: Command = {
  name: "@staged:",
  pattern: /@staged:(\S+)/g,
  async execute(match, context): Promise<ProviderMessageContent[]> {
    const filePath = match[1] as UnresolvedFilePath;
    try {
      const stagedContent = await getStagedDiff(filePath, context.cwd);
      return [
        {
          type: "text",
          text: `Staged diff for \`${filePath}\`:\n\`\`\`diff\n${stagedContent}\n\`\`\``,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ];
    } catch (error) {
      context.nvim.logger.error(
        `Failed to fetch staged diff for \`${filePath}\`: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [
        {
          type: "text",
          text: `Error fetching staged diff for \`${filePath}\`: ${error instanceof Error ? error.message : String(error)}`,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ];
    }
  },
};
