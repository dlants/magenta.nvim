import { $ } from "zx";
import type { AgentInput } from "../../providers/provider-types.ts";
import type { ProjectDir, UnresolvedFilePath } from "../../utils/files.ts";
import type { Command } from "./types.ts";

async function getGitDiff(
  filePath: UnresolvedFilePath,
  projectDir: ProjectDir,
): Promise<string> {
  try {
    const result = await $({
      cwd: projectDir,
      quiet: true,
    })`git diff -- ${filePath}`;
    return result.stdout || "(no unstaged changes)";
  } catch (error) {
    throw new Error(
      `Failed to get git diff: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function getStagedDiff(
  filePath: UnresolvedFilePath,
  projectDir: ProjectDir,
): Promise<string> {
  try {
    const result = await $({
      cwd: projectDir,
      quiet: true,
    })`git diff --staged -- ${filePath}`;
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
  async execute(match, context): Promise<AgentInput[]> {
    const filePath = match[1] as UnresolvedFilePath;
    try {
      const diffContent = await getGitDiff(filePath, context.projectDir);
      return [
        {
          type: "text",
          text: `Git diff for \`${filePath}\`:\n\`\`\`diff\n${diffContent}\n\`\`\``,
        },
      ];
    } catch (error) {
      context.logger.error(
        `Failed to fetch git diff for \`${filePath}\`: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [
        {
          type: "text",
          text: `Error fetching git diff for \`${filePath}\`: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }
  },
};

export const stagedCommand: Command = {
  name: "@staged:",
  pattern: /@staged:(\S+)/g,
  async execute(match, context): Promise<AgentInput[]> {
    const filePath = match[1] as UnresolvedFilePath;
    try {
      const stagedContent = await getStagedDiff(filePath, context.projectDir);
      return [
        {
          type: "text",
          text: `Staged diff for \`${filePath}\`:\n\`\`\`diff\n${stagedContent}\n\`\`\``,
        },
      ];
    } catch (error) {
      context.logger.error(
        `Failed to fetch staged diff for \`${filePath}\`: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [
        {
          type: "text",
          text: `Error fetching staged diff for \`${filePath}\`: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }
  },
};
