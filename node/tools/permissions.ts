import path from "path";
import * as os from "node:os";
import { glob } from "glob";
import type { AbsFilePath, NvimCwd } from "../utils/files.ts";
import type { MagentaOptions } from "../options.ts";
import type { Nvim } from "../nvim/nvim-node";
import { relativePath } from "../utils/files.ts";
import type { Gitignore } from "./util.ts";

function expandTilde(filepath: string): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

function isFileInSkillsDirectory(
  absFilePath: AbsFilePath,
  context: {
    cwd: NvimCwd;
    options: MagentaOptions;
  },
): boolean {
  if (
    !context.options.skillsPaths ||
    context.options.skillsPaths.length === 0
  ) {
    return false;
  }

  for (const skillsDir of context.options.skillsPaths) {
    const expandedDir = expandTilde(skillsDir);
    const skillsDirPath = path.isAbsolute(expandedDir)
      ? expandedDir
      : path.join(context.cwd, expandedDir);

    if (absFilePath.startsWith(skillsDirPath + path.sep)) {
      return true;
    }
  }

  return false;
}

async function isFileAutoAllowed(
  relFilePath: string,
  context: {
    cwd: NvimCwd;
    nvim: Nvim;
    options: MagentaOptions;
  },
): Promise<boolean> {
  if (context.options.getFileAutoAllowGlobs.length === 0) {
    return false;
  }

  for (const pattern of context.options.getFileAutoAllowGlobs) {
    try {
      const matches = await glob(pattern, {
        cwd: context.cwd,
        nocase: true,
        nodir: true,
      });

      if (matches.includes(relFilePath)) {
        return true;
      }
    } catch (error) {
      context.nvim.logger.error(
        `Error checking getFileAutoAllowGlobs pattern "${pattern}": ${(error as Error).message}`,
      );
    }
  }

  return false;
}

export async function canReadFile(
  absFilePath: AbsFilePath,
  context: {
    cwd: NvimCwd;
    nvim: Nvim;
    options: MagentaOptions;
    gitignore: Gitignore;
  },
): Promise<boolean> {
  const relFilePath = relativePath(context.cwd, absFilePath);

  // Skills files are auto-approved for reading
  if (isFileInSkillsDirectory(absFilePath, context)) {
    return true;
  }

  // Check auto-allow globs
  if (await isFileAutoAllowed(relFilePath, context)) {
    return true;
  }

  // Files outside cwd require confirmation
  if (!absFilePath.startsWith(context.cwd)) {
    return false;
  }

  // Hidden files require confirmation
  if (relFilePath.split(path.sep).some((part) => part.startsWith("."))) {
    return false;
  }

  // Gitignored files require confirmation
  if (context.gitignore.ignores(relFilePath)) {
    return false;
  }

  return true;
}

export function canWriteFile(
  absFilePath: AbsFilePath,
  context: {
    cwd: NvimCwd;
    options: MagentaOptions;
    gitignore: Gitignore;
  },
): boolean {
  const relFilePath = relativePath(context.cwd, absFilePath);

  // Skills files always require confirmation for writing
  if (isFileInSkillsDirectory(absFilePath, context)) {
    return false;
  }

  // Files outside cwd require confirmation
  if (!absFilePath.startsWith(context.cwd)) {
    return false;
  }

  // Hidden files require confirmation
  if (relFilePath.split(path.sep).some((part) => part.startsWith("."))) {
    return false;
  }

  // Gitignored files require confirmation
  if (context.gitignore.ignores(relFilePath)) {
    return false;
  }

  return true;
}
