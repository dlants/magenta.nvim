import ignore from "ignore";
import fs from "node:fs";
import path from "node:path";
import {
  resolveFilePath,
  type AbsFilePath,
  type HomeDir,
  type NvimCwd,
  type RelFilePath,
} from "../utils/files.ts";

export type Gitignore = ignore.Ignore;

export function readGitignoreSync(cwd: NvimCwd, homeDir: HomeDir): Gitignore {
  const ig = ignore();
  try {
    const gitignorePath = resolveFilePath(
      cwd,
      ".gitignore" as RelFilePath,
      homeDir,
    );
    const gitignoreContent = fs.readFileSync(gitignorePath, "utf8");
    ig.add(gitignoreContent);
  } catch {
    // If .gitignore doesn't exist, just return empty ignore rules
  }

  return ig;
}

/**
 * Find the git repository root by walking up from the given path.
 * Returns undefined if no .git directory is found.
 */
function findGitRoot(startPath: string): string | undefined {
  let current = startPath;
  const root = path.parse(current).root;

  while (current !== root) {
    const gitPath = path.join(current, ".git");
    try {
      const stat = fs.statSync(gitPath);
      if (stat.isDirectory()) {
        return current;
      }
    } catch {
      // .git doesn't exist at this level, keep walking up
    }
    current = path.dirname(current);
  }

  return undefined;
}

/**
 * Read gitignore rules for a path by walking up from that path to find
 * the git root, then collecting all .gitignore files from root down to the path.
 * This mimics how git itself handles .gitignore files.
 */
export function readGitignoreForPath(targetPath: AbsFilePath): Gitignore {
  const ig = ignore();

  const gitRoot = findGitRoot(targetPath);
  if (!gitRoot) {
    // Not in a git repository, return empty ignore rules
    return ig;
  }

  // Collect all directories from gitRoot down to targetPath
  const dirsToCheck: string[] = [];
  let current: string = targetPath;

  while (current !== gitRoot && current.startsWith(gitRoot)) {
    dirsToCheck.unshift(current);
    current = path.dirname(current);
  }
  dirsToCheck.unshift(gitRoot);

  // Read .gitignore from each directory, from root down to target
  for (const dir of dirsToCheck) {
    try {
      const gitignorePath = path.join(dir, ".gitignore");
      const gitignoreContent = fs.readFileSync(gitignorePath, "utf8");
      // Prefix patterns with the relative path from gitRoot
      const relDir = path.relative(gitRoot, dir);
      if (relDir) {
        // Prefix each non-comment, non-empty line with the relative directory
        const prefixedContent = gitignoreContent
          .split("\n")
          .map((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) {
              return line;
            }
            // Handle negation patterns
            if (trimmed.startsWith("!")) {
              return `!${relDir}/${trimmed.slice(1)}`;
            }
            return `${relDir}/${trimmed}`;
          })
          .join("\n");
        ig.add(prefixedContent);
      } else {
        ig.add(gitignoreContent);
      }
    } catch {
      // .gitignore doesn't exist at this level, continue
    }
  }

  return ig;
}

/**
 * Recursively collect all .gitignore files from a directory tree and combine them.
 * Patterns from subdirectory .gitignore files are prefixed with their relative path.
 */
function collectGitignoresRecursive(
  dir: string,
  rootDir: string,
  ig: ignore.Ignore,
): void {
  try {
    const gitignorePath = path.join(dir, ".gitignore");
    const gitignoreContent = fs.readFileSync(gitignorePath, "utf8");
    const relDir = path.relative(rootDir, dir);

    if (relDir) {
      // Prefix each non-comment, non-empty line with the relative directory
      const prefixedContent = gitignoreContent
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) {
            return line;
          }
          // Handle negation patterns
          if (trimmed.startsWith("!")) {
            return `!${relDir}/${trimmed.slice(1)}`;
          }
          return `${relDir}/${trimmed}`;
        })
        .join("\n");
      ig.add(prefixedContent);
    } else {
      ig.add(gitignoreContent);
    }
  } catch {
    // .gitignore doesn't exist at this level
  }

  // Recursively check subdirectories
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== ".git") {
        collectGitignoresRecursive(path.join(dir, entry.name), rootDir, ig);
      }
    }
  } catch {
    // Can't read directory
  }
}

/**
 * Read all .gitignore files from a directory tree, combining patterns properly.
 * This is used when listing directories within the cwd.
 */
export function readAllGitignoresSync(cwd: NvimCwd): Gitignore {
  const ig = ignore();
  collectGitignoresRecursive(cwd, cwd, ig);
  return ig;
}
