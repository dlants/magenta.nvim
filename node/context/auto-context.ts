import { glob } from "glob";
import path from "node:path";
import fs from "node:fs";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { MagentaOptions } from "../options.ts";
import {
  relativePath,
  resolveFilePath,
  detectFileType,
  FileCategory,
  type AbsFilePath,
  type HomeDir,
  type NvimCwd,
  type RelFilePath,
  type UnresolvedFilePath,
  type FileTypeInfo,
} from "../utils/files.ts";
import type { Files } from "./context-manager.ts";

export type AutoContextFile = {
  absFilePath: AbsFilePath;
  relFilePath: RelFilePath;
  fileTypeInfo: FileTypeInfo;
};

export async function resolveAutoContext(context: {
  nvim: Nvim;
  cwd: NvimCwd;
  homeDir: HomeDir;
  options: MagentaOptions;
}): Promise<AutoContextFile[]> {
  const { nvim, cwd, homeDir, options } = context;

  if (!options.autoContext || options.autoContext.length === 0) {
    return [];
  }

  try {
    const matchedFiles = await findFilesCrossPlatform(
      options.autoContext,
      cwd,
      nvim,
      homeDir,
    );

    return await filterSupportedFiles(matchedFiles, nvim);
  } catch (err) {
    nvim.logger.error(`Error loading auto context: ${(err as Error).message}`);
    return [];
  }
}

async function findFilesCrossPlatform(
  globPatterns: string[],
  cwd: NvimCwd,
  nvim: Nvim,
  homeDir: HomeDir,
): Promise<Array<{ absFilePath: AbsFilePath; relFilePath: RelFilePath }>> {
  const allMatchedPaths: Array<{
    absFilePath: AbsFilePath;
    relFilePath: RelFilePath;
  }> = [];

  await Promise.all(
    globPatterns.map(async (pattern) => {
      try {
        const matches = await glob(pattern, {
          cwd,
          nocase: true,
          nodir: true,
        });

        for (const match of matches) {
          const absFilePath = resolveFilePath(
            cwd,
            match as UnresolvedFilePath,
            homeDir,
          );
          if (fs.existsSync(absFilePath)) {
            allMatchedPaths.push({
              absFilePath,
              relFilePath: relativePath(cwd, absFilePath, homeDir),
            });
          }
        }
      } catch (err) {
        nvim.logger.error(
          `Error processing glob pattern "${pattern}": ${(err as Error).message}`,
        );
      }
    }),
  );

  const uniqueFiles = new Map<
    string,
    { absFilePath: AbsFilePath; relFilePath: RelFilePath }
  >();

  for (const fileInfo of allMatchedPaths) {
    try {
      const canonicalPath = fs.realpathSync(fileInfo.absFilePath);
      const normalizedPath = path.normalize(canonicalPath);

      if (!uniqueFiles.has(normalizedPath)) {
        uniqueFiles.set(normalizedPath, fileInfo);
      }
    } catch {
      const normalizedPath = path.normalize(fileInfo.absFilePath);
      if (!uniqueFiles.has(normalizedPath)) {
        uniqueFiles.set(normalizedPath, fileInfo);
      }
    }
  }

  return Array.from(uniqueFiles.values());
}

async function filterSupportedFiles(
  matchedFiles: Array<{ absFilePath: AbsFilePath; relFilePath: RelFilePath }>,
  nvim: Nvim,
): Promise<AutoContextFile[]> {
  const supportedFiles: AutoContextFile[] = [];

  await Promise.all(
    matchedFiles.map(async (fileInfo) => {
      try {
        const fileTypeInfo = await detectFileType(fileInfo.absFilePath);
        if (!fileTypeInfo) {
          nvim.logger.error(`File ${fileInfo.relFilePath} does not exist.`);
          return;
        }
        if (fileTypeInfo.category !== FileCategory.UNSUPPORTED) {
          supportedFiles.push({ ...fileInfo, fileTypeInfo });
        } else {
          nvim.logger.warn(
            `Skipping ${fileInfo.relFilePath} from auto-context: ${fileTypeInfo.category} files are not supported in context (detected MIME type: ${fileTypeInfo.mimeType})`,
          );
        }
      } catch (error) {
        nvim.logger.error(
          `Failed to detect file type for ${fileInfo.relFilePath} during auto-context loading: ${(error as Error).message}`,
        );
      }
    }),
  );

  return supportedFiles;
}
export function autoContextFilesToInitialFiles(
  files: AutoContextFile[],
): Files {
  const result: Files = {};
  for (const file of files) {
    result[file.absFilePath] = {
      relFilePath: file.relFilePath,
      fileTypeInfo: file.fileTypeInfo,
      agentView: undefined,
    };
  }
  return result;
}
