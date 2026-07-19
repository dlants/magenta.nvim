import * as path from "node:path";

import type { FileIO } from "../capabilities/file-io.ts";
import type { Logger } from "../logger.ts";
import type { ProviderOptions } from "../provider-options.ts";
import {
  type AbsFilePath,
  expandTilde,
  type HomeDir,
  type NvimCwd,
} from "../utils/files.ts";

export type SkillInfo = {
  skillFile: AbsFilePath;
  name: string;
  description: string;
};

export type SkillsMap = {
  [skillName: string]: SkillInfo;
};

type YamlFrontmatter = {
  name?: string;
  description?: string;
};

export async function loadSkills(context: {
  cwd: NvimCwd;
  logger: Logger;
  options: ProviderOptions;
  fileIO: FileIO;
  homeDir: HomeDir;
}): Promise<SkillsMap> {
  const skills: SkillsMap = {};

  if (
    !context.options.skillsPaths ||
    context.options.skillsPaths.length === 0
  ) {
    return skills;
  }

  const suppressedNames = new Set(context.options.suppressProjectSkills ?? []);

  try {
    // Process each skills directory in order
    // Later directories override earlier ones
    for (const skillsDir of context.options.skillsPaths) {
      const isUserLevel = isUserLevelSkillsDir(skillsDir, context.homeDir);
      const skillFiles = await findSkillFilesInDirectory(skillsDir, context);

      for (const skillFile of skillFiles) {
        try {
          const skillInfo = await parseSkillFile(skillFile, context);
          if (skillInfo) {
            if (!isUserLevel && suppressedNames.has(skillInfo.name)) {
              context.logger.info(
                `Suppressing project-level skill "${skillInfo.name}" from ${skillFile}`,
              );
              continue;
            }
            if (skillInfo.name in skills) {
              context.logger.info(
                `Skill "${skillInfo.name}" from ${skillFile} overrides skill from ${skills[skillInfo.name].skillFile}`,
              );
            }
            // Later directories override earlier ones
            skills[skillInfo.name] = skillInfo;
          }
        } catch (err) {
          context.logger.error(
            `Error parsing skill file ${skillFile}: ${(err as Error).message}`,
          );
        }
      }
    }
  } catch (err) {
    context.logger.error(`Error loading skills: ${(err as Error).message}`);
  }

  return skills;
}

function isUserLevelSkillsDir(skillsDir: string, homeDir: HomeDir): boolean {
  const expandedDir = expandTilde(skillsDir, homeDir);
  if (!path.isAbsolute(expandedDir)) {
    return false;
  }
  const homeWithSep = homeDir.endsWith(path.sep) ? homeDir : homeDir + path.sep;
  return expandedDir === homeDir || expandedDir.startsWith(homeWithSep);
}

async function findSkillFilesInDirectory(
  skillsDir: string,
  context: {
    cwd: NvimCwd;
    logger: Logger;
    fileIO: FileIO;
    homeDir: HomeDir;
  },
): Promise<AbsFilePath[]> {
  const expandedDir = expandTilde(skillsDir, context.homeDir);

  // Build the list of directories to scan.
  // For absolute paths, scan that one directory.
  // For relative paths, walk from filesystem root down to cwd, applying the
  // relative path at each ancestor. This way more deeply-nested directories
  // (closer to cwd) override skills from parent directories via the override
  // logic in loadSkills.
  const directoriesToScan: string[] = [];

  if (path.isAbsolute(expandedDir)) {
    directoriesToScan.push(expandedDir);
  } else {
    const ancestors: string[] = [];
    let current: string = context.cwd;
    while (true) {
      ancestors.push(path.join(current, expandedDir));
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
    // Reverse so outermost (filesystem root) is first, innermost (cwd) is last
    directoriesToScan.push(...ancestors.reverse());
  }

  const skillFiles: AbsFilePath[] = [];
  for (const skillsDirPath of directoriesToScan) {
    try {
      if (!(await context.fileIO.isDirectory(skillsDirPath))) {
        continue;
      }

      const entries = await context.fileIO.readdir(skillsDirPath);

      for (const entry of entries) {
        const entryPath = path.join(skillsDirPath, entry);

        if (!(await context.fileIO.isDirectory(entryPath))) {
          continue;
        }

        const files = await context.fileIO.readdir(entryPath);
        const skillFile = files.find(
          (file) => file.toLowerCase() === "skill.md",
        );

        if (skillFile) {
          const absPath = path.join(entryPath, skillFile);
          skillFiles.push(absPath as AbsFilePath);
        }
      }
    } catch (err) {
      context.logger.error(
        `Error processing skills directory "${skillsDirPath}": ${(err as Error).message}`,
      );
    }
  }

  return skillFiles;
}

async function parseSkillFile(
  skillFile: AbsFilePath,
  context: { logger: Logger; fileIO: FileIO },
): Promise<SkillInfo | undefined> {
  const content = await context.fileIO.readFile(skillFile);

  const frontmatter = extractYamlFrontmatter(content);

  if (!frontmatter) {
    context.logger.warn(`Skill file ${skillFile} is missing YAML frontmatter`);
    return undefined;
  }

  if (!frontmatter.name || !frontmatter.description) {
    context.logger.warn(
      `Skill file ${skillFile} is missing required fields (name and/or description) in YAML frontmatter`,
    );
    return undefined;
  }

  return {
    skillFile,
    name: frontmatter.name,
    description: frontmatter.description,
  };
}

export function extractYamlFrontmatter(
  content: string,
): YamlFrontmatter | undefined {
  const lines = content.split("\n");

  // First line must be just "---"
  if (lines.length === 0 || lines[0].trim() !== "---") {
    return undefined;
  }

  // Find the closing "---" line
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return undefined;
  }

  // Parse frontmatter lines as simple key: value pairs.
  // We avoid a full YAML parser because skill files from other tools (e.g.
  // Claude Code) may contain values with unquoted colons that are invalid YAML.
  const result: YamlFrontmatter = {};
  for (let i = 1; i < endIndex; i++) {
    const colonIndex = lines[i].indexOf(":");
    if (colonIndex === -1) continue;
    const key = lines[i].slice(0, colonIndex).trim();
    const value = lines[i].slice(colonIndex + 1).trim();
    if (key === "name" || key === "description") {
      result[key] = value;
    }
  }
  return result;
}

export function formatSkillsIntroduction(skills: SkillsMap): string {
  if (Object.keys(skills).length === 0) {
    return "";
  }

  const skillsList = Object.values(skills)
    .map(
      (skill) =>
        `- **${skill.name}** (\`${skill.skillFile}\`): ${skill.description}`,
    )
    .join("\n");

  return `
# Available Skills

Here are skills you have available to you:

<available-skills>
${skillsList}
</available-skills>

When a skill is relevant to a task, you MUST use the get_files tool to read the skill.md file.`;
}
