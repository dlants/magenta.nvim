import path from "path";
import { glob } from "glob";
import type { AbsFilePath, HomeDir, NvimCwd } from "../utils/files.ts";
import type { FilePermission, MagentaOptions } from "../options.ts";
import type { Nvim } from "../nvim/nvim-node";
import { relativePath, MAGENTA_TEMP_DIR, expandTilde } from "../utils/files.ts";

export type EffectivePermissions = {
  read: boolean;
  write: boolean;
  readSecret: boolean;
  writeSecret: boolean;
};

/**
 * Given a file path, determine the effective permissions by checking all
 * configured permission rules. Permissions are inherited from parent paths.
 *
 * Includes implicit default: cwd has read: true, write: true
 */
export function getEffectivePermissions(
  absFilePath: AbsFilePath,
  filePermissions: FilePermission[],
  cwd: NvimCwd,
  homeDir: HomeDir,
): EffectivePermissions {
  const permissions: EffectivePermissions = {
    read: false,
    write: false,
    readSecret: false,
    writeSecret: false,
  };

  // Add implicit cwd permission (read + write, but not secrets)
  const cwdPermission: FilePermission = {
    path: cwd,
    read: true,
    write: true,
  };

  const allPermissions = [cwdPermission, ...filePermissions];

  for (const perm of allPermissions) {
    const permPath = expandTilde(perm.path, homeDir);
    const normalizedPermPath = path.isAbsolute(permPath)
      ? permPath
      : path.join(cwd, permPath);

    // Check if the file is under this permission path
    if (
      absFilePath === normalizedPermPath ||
      absFilePath.startsWith(normalizedPermPath + path.sep)
    ) {
      // Union permissions (grant if any matching rule grants)
      if (perm.read) permissions.read = true;
      if (perm.write) permissions.write = true;
      if (perm.readSecret) permissions.readSecret = true;
      if (perm.writeSecret) permissions.writeSecret = true;
    }
  }

  return permissions;
}

/**
 * Check if a file path has a new hidden segment after the permission path.
 * A "new" hidden segment is one that appears after the permission path portion.
 *
 * Example:
 *   hasNewSecretSegment("/Users/x/.config/nvim/init.lua", "/Users/x/.config") → false
 *   hasNewSecretSegment("/Users/x/.config/folder/.env", "/Users/x/.config") → true (.env is new)
 *   hasNewSecretSegment("/Users/x/projects/.secret", "/Users/x/projects") → true (.secret is new)
 */
export function hasNewSecretSegment(
  absFilePath: AbsFilePath,
  permissionPath: string,
  cwd: NvimCwd,
  homeDir: HomeDir,
): boolean {
  const expandedPermPath = expandTilde(permissionPath, homeDir);
  const normalizedPermPath = path.isAbsolute(expandedPermPath)
    ? expandedPermPath
    : path.join(cwd, expandedPermPath);

  // Get the portion of the path after the permission path
  if (!absFilePath.startsWith(normalizedPermPath)) {
    return false;
  }

  const relativePortion = absFilePath.slice(normalizedPermPath.length);
  if (!relativePortion) {
    return false;
  }

  // Split by path separator and check if any segment is hidden (starts with ".")
  const segments = relativePortion.split(path.sep).filter((s) => s.length > 0);
  return segments.some((segment) => segment.startsWith("."));
}

function isFileInMagentaTempDirectory(absFilePath: AbsFilePath): boolean {
  return absFilePath.startsWith(MAGENTA_TEMP_DIR + path.sep);
}

function isFileInSkillsDirectory(
  absFilePath: AbsFilePath,
  context: {
    cwd: NvimCwd;
    homeDir: HomeDir;
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
    const expandedDir = expandTilde(skillsDir, context.homeDir);
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

/**
 * Check if a segment is a hidden segment (starts with ".")
 */
function isHiddenSegment(segment: string): boolean {
  return segment.startsWith(".");
}

/**
 * Check if a file is a "secret" file (has hidden segments) and whether those
 * segments are new relative to any permission path that covers this file.
 *
 * A file requires secret permissions if it has hidden segments that appear
 * after all applicable permission paths.
 */
function fileRequiresSecretPermission(
  absFilePath: AbsFilePath,
  filePermissions: FilePermission[],
  cwd: NvimCwd,
  homeDir: HomeDir,
): boolean {
  // Check the absolute path segments for hidden segments
  const pathSegments = absFilePath.split(path.sep).filter((s) => s.length > 0);
  if (!pathSegments.some(isHiddenSegment)) {
    return false;
  }

  // Check all permission paths that cover this file
  // If any permission path covers the hidden segments, then it doesn't need secret permission
  const cwdPermission: FilePermission = { path: cwd, read: true, write: true };
  const allPermissions = [cwdPermission, ...filePermissions];

  for (const perm of allPermissions) {
    const permPath = expandTilde(perm.path, homeDir);
    const normalizedPermPath = path.isAbsolute(permPath)
      ? permPath
      : path.join(cwd, permPath);

    // Check if this permission path covers the file
    if (
      absFilePath === normalizedPermPath ||
      absFilePath.startsWith(normalizedPermPath + path.sep)
    ) {
      // If there are no new secret segments after this permission path, and
      // this permission has read or write (not just secret), then the file
      // can be accessed without secret permission via this rule
      if (!hasNewSecretSegment(absFilePath, perm.path, cwd, homeDir)) {
        return false;
      }
    }
  }

  // All covering permission paths have new secret segments after them
  return true;
}

export async function canReadFile(
  absFilePath: AbsFilePath,
  context: {
    cwd: NvimCwd;
    homeDir: HomeDir;
    nvim: Nvim;
    options: MagentaOptions;
  },
): Promise<boolean> {
  const relFilePath = relativePath(context.cwd, absFilePath, context.homeDir);

  // Magenta temp files (e.g., bash command logs) are auto-approved for reading
  if (isFileInMagentaTempDirectory(absFilePath)) {
    return true;
  }

  // Skills files are auto-approved for reading
  if (isFileInSkillsDirectory(absFilePath, context)) {
    return true;
  }

  // Check auto-allow globs (deprecated, will be removed)
  if (await isFileAutoAllowed(relFilePath, context)) {
    return true;
  }

  // Get effective permissions from filePermissions config
  const effectivePerms = getEffectivePermissions(
    absFilePath,
    context.options.filePermissions,
    context.cwd,
    context.homeDir,
  );

  // Check if this file requires secret permissions
  const needsSecret = fileRequiresSecretPermission(
    absFilePath,
    context.options.filePermissions,
    context.cwd,
    context.homeDir,
  );

  if (needsSecret) {
    // Needs readSecret permission
    return effectivePerms.readSecret;
  } else {
    // Regular read permission (or readSecret, which is a superset)
    return effectivePerms.read || effectivePerms.readSecret;
  }
}

export function canWriteFile(
  absFilePath: AbsFilePath,
  context: {
    cwd: NvimCwd;
    homeDir: HomeDir;
    options: MagentaOptions;
  },
): boolean {
  // Files in magenta temp directory are always writable (magenta owns that directory)
  if (isFileInMagentaTempDirectory(absFilePath)) {
    return true;
  }
  // Skills files always require confirmation for writing
  if (isFileInSkillsDirectory(absFilePath, context)) {
    return false;
  }

  // Get effective permissions from filePermissions config
  const effectivePerms = getEffectivePermissions(
    absFilePath,
    context.options.filePermissions,
    context.cwd,
    context.homeDir,
  );

  // Check if this file requires secret permissions
  const needsSecret = fileRequiresSecretPermission(
    absFilePath,
    context.options.filePermissions,
    context.cwd,
    context.homeDir,
  );

  if (needsSecret) {
    // Needs writeSecret permission
    return effectivePerms.writeSecret;
  } else {
    // Regular write permission (or writeSecret, which is a superset)
    return effectivePerms.write || effectivePerms.writeSecret;
  }
}
