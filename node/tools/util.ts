import ignore from "ignore";
import fs from "node:fs";
import {
  resolveFilePath,
  type NvimCwd,
  type RelFilePath,
} from "../utils/files";

export type Gitignore = ignore.Ignore;

export function readGitignoreSync(cwd: NvimCwd): Gitignore {
  const ig = ignore();
  try {
    const gitignorePath = resolveFilePath(cwd, ".gitignore" as RelFilePath);
    const gitignoreContent = fs.readFileSync(gitignorePath, "utf8");
    ig.add(gitignoreContent);
  } catch {
    // If .gitignore doesn't exist, just return empty ignore rules
  }

  return ig;
}
