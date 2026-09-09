import fs from "node:fs";
import path from "node:path";
import { glob } from "glob";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { MagentaOptions } from "../options.ts";
import {
  type AbsFilePath,
  detectFileType,
  expandTilde,
  FileCategory,
  type FileTypeInfo,
  type HomeDir,
  type NvimCwd,
  type RelFilePath,
  relativePath,
  resolveFilePath,
  type UnresolvedFilePath,
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
  type Match = { absFilePath: AbsFilePath; relFilePath: RelFilePath };

  const perPatternMatches = await Promise.all(
    globPatterns.map(async (pattern): Promise<Match[]> => {
      const matchesForPattern: Match[] = [];
      try {
        const expandedPattern = expandTilde(pattern, homeDir);
        const matches = await glob(expandedPattern, {
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
            matchesForPattern.push({
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
      return matchesForPattern;
    }),
  );

  const allMatchedPaths: Match[] = perPatternMatches.flat();

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
  const results = await Promise.all(
    matchedFiles.map(async (fileInfo): Promise<AutoContextFile | undefined> => {
      try {
        const fileTypeInfo = await detectFileType(fileInfo.absFilePath);
        if (!fileTypeInfo) {
          nvim.logger.error(`File ${fileInfo.relFilePath} does not exist.`);
          return undefined;
        }
        if (fileTypeInfo.category !== FileCategory.UNSUPPORTED) {
          return { ...fileInfo, fileTypeInfo };
        }
        nvim.logger.warn(
          `Skipping ${fileInfo.relFilePath} from auto-context: ${fileTypeInfo.category} files are not supported in context (detected MIME type: ${fileTypeInfo.mimeType})`,
        );
        return undefined;
      } catch (error) {
        nvim.logger.error(
          `Failed to detect file type for ${fileInfo.relFilePath} during auto-context loading: ${(error as Error).message}`,
        );
        return undefined;
      }
    }),
  );

  return results.filter((f): f is AutoContextFile => f !== undefined);
}
export async function discoverHierarchyContext(
  absFilePath: AbsFilePath,
  ctx: {
    nvim: Nvim;
    cwd: NvimCwd;
    homeDir: HomeDir;
    options: MagentaOptions;
  },
): Promise<AutoContextFile[]> {
  const { nvim, cwd, homeDir, options } = ctx;
  const names = options.hierarchyContextFileNames;
  if (!names || names.length === 0) {
    return [];
  }

  const targetNames = new Set(names.map((n) => n.toLowerCase()));

  const results: AutoContextFile[] = [];
  let current = path.dirname(absFilePath);
  while (true) {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(current);
    } catch (err) {
      nvim.logger.debug(
        `discoverHierarchyContext: unable to read ${current}: ${(err as Error).message}`,
      );
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
      continue;
    }

    for (const entry of entries) {
      if (!targetNames.has(entry.toLowerCase())) {
        continue;
      }
      const matchAbs = path.join(current, entry) as AbsFilePath;
      try {
        const fileTypeInfo = await detectFileType(matchAbs);
        if (!fileTypeInfo) {
          continue;
        }
        if (fileTypeInfo.category === FileCategory.UNSUPPORTED) {
          continue;
        }
        results.push({
          absFilePath: matchAbs,
          relFilePath: relativePath(cwd, matchAbs, homeDir),
          fileTypeInfo,
        });
      } catch (err) {
        nvim.logger.debug(
          `discoverHierarchyContext: failed to detect file type for ${matchAbs}: ${(err as Error).message}`,
        );
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return results;
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
