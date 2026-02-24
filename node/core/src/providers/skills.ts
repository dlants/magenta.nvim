import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { Logger } from "../logger.ts";
import type { Cwd, AbsFilePath } from "../paths.ts";
import type { ProviderOptions } from "../provider-options.ts";

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

export function loadSkills(context: {
  cwd: Cwd;
  logger: Logger;
  options: ProviderOptions;
}): SkillsMap {
  const skills: SkillsMap = {};

  if (
    !context.options.skillsPaths ||
    context.options.skillsPaths.length === 0
  ) {
    return skills;
  }

  try {
    // Process each skills directory in order
    // Later directories override earlier ones
    for (const skillsDir of context.options.skillsPaths) {
      const skillFiles = findSkillFilesInDirectory(skillsDir, context);

      for (const skillFile of skillFiles) {
        try {
          const skillInfo = parseSkillFile(skillFile, context);
          if (skillInfo) {
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

function expandTilde(filepath: string): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

function findSkillFilesInDirectory(
  skillsDir: string,
  context: {
    cwd: Cwd;
    logger: Logger;
  },
): AbsFilePath[] {
  const skillFiles: AbsFilePath[] = [];

  try {
    // Expand tilde, then resolve the skills directory path
    // If it's absolute, use it as-is; otherwise resolve relative to cwd
    const expandedDir = expandTilde(skillsDir);
    const skillsDirPath = path.isAbsolute(expandedDir)
      ? expandedDir
      : path.join(context.cwd, expandedDir);

    // Check if the skills directory exists
    try {
      const stats = fs.statSync(skillsDirPath);
      if (!stats.isDirectory()) {
        context.logger.warn(`Skills path "${skillsDir}" is not a directory`);
        return skillFiles;
      }
    } catch {
      // Directory doesn't exist, skip silently
      return skillFiles;
    }

    // Read immediate children of the skills directory
    const entries = fs.readdirSync(skillsDirPath);

    for (const entry of entries) {
      const entryPath = path.join(skillsDirPath, entry);

      // Check if it's a directory
      try {
        const stats = fs.statSync(entryPath);
        if (!stats.isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }

      // Look for skill.md file (case-insensitive)
      const files = fs.readdirSync(entryPath);
      const skillFile = files.find((file) => file.toLowerCase() === "skill.md");

      if (skillFile) {
        const absPath = path.join(entryPath, skillFile);
        skillFiles.push(absPath as AbsFilePath);
      }
    }
  } catch (err) {
    context.logger.error(
      `Error processing skills directory "${skillsDir}": ${(err as Error).message}`,
    );
  }

  return skillFiles;
}

function parseSkillFile(
  skillFile: AbsFilePath,
  context: { logger: Logger },
): SkillInfo | undefined {
  const content = fs.readFileSync(skillFile, "utf8");

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

function extractYamlFrontmatter(content: string): YamlFrontmatter | undefined {
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

  // Extract YAML content between the delimiters
  const yamlLines = lines.slice(1, endIndex);
  const yamlContent = yamlLines.join("\n");

  try {
    const parsed = parseYaml(yamlContent) as YamlFrontmatter;
    return parsed;
  } catch (err) {
    throw new Error(
      `Failed to parse YAML frontmatter: ${(err as Error).message}`,
    );
  }
}

export function formatSkillsIntroduction(skills: SkillsMap, cwd: Cwd): string {
  if (Object.keys(skills).length === 0) {
    return "";
  }

  const skillsList = Object.values(skills)
    .map((skill) => {
      // Use relative path if inside cwd, absolute path otherwise
      const relPath = path.relative(cwd, skill.skillFile);
      const displayPath = relPath.startsWith("..") ? skill.skillFile : relPath;
      return `- **${skill.name}** (\`${displayPath}\`): ${skill.description}`;
    })
    .join("\n");

  return `
# Available Skills

Here are skills you have available to you:

<available-skills>
${skillsList}
</available-skills>

When a skill is relevant to a task, you MUST use the get_file tool to read the skill.md file.`;
}
