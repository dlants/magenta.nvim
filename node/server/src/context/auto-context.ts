import path from "node:path";
import type { FileIO } from "../capabilities/file-io.ts";
import type { Logger } from "../logger.ts";
import type { Files } from "../supervisors/file-supervisor.ts";
import {
  type AbsFilePath,
  detectFileTypeViaFileIO,
  expandTilde,
  FileCategory,
  type FileTypeInfo,
  type HomeDir,
  type NvimCwd,
  type RelFilePath,
  relativePath,
} from "../utils/files.ts";

export type AutoContextFile = {
  absFilePath: AbsFilePath;
  relFilePath: RelFilePath;
  fileTypeInfo: FileTypeInfo;
};

type Match = { absFilePath: AbsFilePath; relFilePath: RelFilePath };

export async function resolveAutoContext(ctx: {
  fileIO: FileIO;
  logger: Logger;
  cwd: NvimCwd;
  homeDir: HomeDir;
  globs: string[] | undefined;
}): Promise<AutoContextFile[]> {
  const { fileIO, logger, cwd, homeDir, globs } = ctx;
  if (!globs || globs.length === 0) {
    return [];
  }

  try {
    const perPattern = await Promise.all(
      globs.map(async (pattern): Promise<Match[]> => {
        try {
          const paths = await globFiles(
            fileIO,
            expandTilde(pattern, homeDir),
            cwd,
          );
          return paths.map((absFilePath) => ({
            absFilePath,
            relFilePath: relativePath(cwd, absFilePath, homeDir),
          }));
        } catch (err) {
          logger.error(
            `Error processing glob pattern "${pattern}": ${(err as Error).message}`,
          );
          return [];
        }
      }),
    );

    // Dedup is lexical: a symlink and its target are both kept (FileIO has no
    // realpath).
    const unique = new Map<string, Match>();
    for (const match of perPattern.flat()) {
      const key = path.normalize(match.absFilePath);
      if (!unique.has(key)) unique.set(key, match);
    }

    return await filterSupportedFiles([...unique.values()], fileIO, logger);
  } catch (err) {
    logger.error(`Error loading auto context: ${(err as Error).message}`);
    return [];
  }
}

/** Minimal glob over FileIO mirroring the `glob` package options previously
 * used (nocase, nodir, default dot:false): `*`, `?`, `[...]`, `{a,b}` within a
 * segment and `**` across segments. Wildcards don't match leading dots. */
export async function globFiles(
  fileIO: FileIO,
  pattern: string,
  cwd: string,
): Promise<AbsFilePath[]> {
  const isAbs = path.isAbsolute(pattern);
  const root = isAbs ? path.parse(pattern).root : cwd;
  const segments = pattern
    .slice(isAbs ? root.length : 0)
    .split(/[\\/]+/)
    .filter((s) => s.length > 0 && s !== ".");

  const results = new Set<AbsFilePath>();
  const visited = new Set<string>();

  const walk = async (dir: string, idx: number): Promise<void> => {
    const key = `${dir}\0${idx}`;
    if (visited.has(key)) return;
    visited.add(key);

    if (idx === segments.length) {
      if (dir !== root && !(await fileIO.isDirectory(dir))) {
        results.add(dir as AbsFilePath);
      }
      return;
    }
    const seg = segments[idx];
    if (seg === "**") {
      await walk(dir, idx + 1);
      for (const entry of await safeReaddir(fileIO, dir)) {
        if (entry.startsWith(".")) continue;
        const child = path.join(dir, entry);
        if (await fileIO.isDirectory(child)) {
          await walk(child, idx);
        } else if (idx === segments.length - 1) {
          results.add(child as AbsFilePath);
        }
      }
      return;
    }
    if (seg === "..") {
      await walk(path.dirname(dir), idx + 1);
      return;
    }
    const isLast = idx === segments.length - 1;
    const re = segmentToRegExp(seg);
    for (const entry of await safeReaddir(fileIO, dir)) {
      if (!re.test(entry)) continue;
      const child = path.join(dir, entry);
      if (!isLast && !(await fileIO.isDirectory(child))) continue;
      await walk(child, idx + 1);
    }
  };

  await walk(root, 0);
  return [...results].sort();
}

async function safeReaddir(fileIO: FileIO, dir: string): Promise<string[]> {
  try {
    return await fileIO.readdir(dir);
  } catch {
    return [];
  }
}

function segmentToRegExp(seg: string): RegExp {
  let re = "";
  let inBraces = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = seg.indexOf("]", i + 1);
      if (end === -1) {
        re += "\\[";
      } else {
        let body = seg.slice(i + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else if (c === "{") {
      inBraces = true;
      re += "(?:";
    } else if (c === "}" && inBraces) {
      inBraces = false;
      re += ")";
    } else if (c === "," && inBraces) re += "|";
    else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  const dotGuard = seg.startsWith(".") ? "" : "(?!\\.)";
  return new RegExp(`^${dotGuard}${re}$`, "i");
}

async function filterSupportedFiles(
  matchedFiles: Match[],
  fileIO: FileIO,
  logger: Logger,
): Promise<AutoContextFile[]> {
  const results = await Promise.all(
    matchedFiles.map(async (fileInfo): Promise<AutoContextFile | undefined> => {
      try {
        const fileTypeInfo = await detectFileTypeViaFileIO(
          fileInfo.absFilePath,
          fileIO,
        );
        if (!fileTypeInfo) {
          logger.error(`File ${fileInfo.relFilePath} does not exist.`);
          return undefined;
        }
        if (fileTypeInfo.category !== FileCategory.UNSUPPORTED) {
          return { ...fileInfo, fileTypeInfo };
        }
        logger.warn(
          `Skipping ${fileInfo.relFilePath} from auto-context: ${fileTypeInfo.category} files are not supported in context (detected MIME type: ${fileTypeInfo.mimeType})`,
        );
        return undefined;
      } catch (error) {
        logger.error(
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
    fileIO: FileIO;
    logger: Logger;
    cwd: NvimCwd;
    homeDir: HomeDir;
    hierarchyContextFileNames: string[] | undefined;
  },
): Promise<AutoContextFile[]> {
  const { fileIO, logger, cwd, homeDir } = ctx;
  const names = ctx.hierarchyContextFileNames;
  if (!names || names.length === 0) {
    return [];
  }
  const targetNames = new Set(names.map((n) => n.toLowerCase()));

  const results: AutoContextFile[] = [];
  let current = path.dirname(absFilePath);
  while (true) {
    let entries: string[] = [];
    try {
      entries = await fileIO.readdir(current);
    } catch (err) {
      logger.debug(
        `discoverHierarchyContext: unable to read ${current}: ${(err as Error).message}`,
      );
    }

    for (const entry of entries) {
      if (!targetNames.has(entry.toLowerCase())) continue;
      const matchAbs = path.join(current, entry) as AbsFilePath;
      try {
        const fileTypeInfo = await detectFileTypeViaFileIO(matchAbs, fileIO);
        if (
          !fileTypeInfo ||
          fileTypeInfo.category === FileCategory.UNSUPPORTED
        ) {
          continue;
        }
        results.push({
          absFilePath: matchAbs,
          relFilePath: relativePath(cwd, matchAbs, homeDir),
          fileTypeInfo,
        });
      } catch (err) {
        logger.debug(
          `discoverHierarchyContext: failed to detect file type for ${matchAbs}: ${(err as Error).message}`,
        );
      }
    }

    const parent = path.dirname(current);
    if (parent === current) break;
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
      lastStat: undefined,
    };
  }
  return result;
}
