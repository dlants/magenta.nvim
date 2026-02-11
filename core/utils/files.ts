export type AbsFilePath = string & { __abs_file_path: true };
export type RelFilePath = string & { __rel_file_path: true };
export type UnresolvedFilePath = string & { __unresolved_file_path: true };
export type HomeDir = AbsFilePath & { __home_dir: true };
export type DisplayPath = string & { __display_path: true };

/** Nominal type representing the working directory for an agent.
 * Some agents are situated in a specific directory; others float without a cwd.
 */
export type Cwd = AbsFilePath & { __cwd: true };

import * as path from "path";

export function resolveFilePath(
  cwd: Cwd,
  filePath: string,
  homeDir: HomeDir,
): AbsFilePath {
  let expandedPath = filePath;
  if (expandedPath.startsWith("~/") || expandedPath === "~") {
    expandedPath = path.join(homeDir, expandedPath.slice(1));
  }
  return path.resolve(cwd, expandedPath) as AbsFilePath;
}
