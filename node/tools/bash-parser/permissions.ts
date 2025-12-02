import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import type { ParsedCommand, ParsedCommandList } from "./parser.ts";
import { parse, ParserError } from "./parser.ts";
import { LexerError } from "./lexer.ts";
import {
  resolveFilePath,
  type NvimCwd,
  type UnresolvedFilePath,
} from "../../utils/files.ts";
import type { Gitignore } from "../util.ts";

/** A single argument specification */
export type ArgSpec =
  | string // Exact literal argument
  | { file: true } // Single file path argument
  | { restFiles: true } // Zero or more file paths (must be last)
  | { any: true } // Any single argument (wildcard)
  | { pattern: string }; // Argument matching a regex pattern

/** Configuration for a single command */
export type CommandSpec = {
  subCommands?: Record<string, CommandSpec>;
  args?: ArgSpec[][]; // Array of allowed arg patterns
  allowAll?: true; // Allow any arguments (useful for safe commands)
};

/** Top-level command permissions configuration */
export type CommandPermissions = Record<string, CommandSpec>;

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

function expandTilde(filePath: string): string {
  if (filePath.startsWith("~/") || filePath === "~") {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

/** Check if a path is safe (within project cwd and not hidden) */
function isPathSafe(
  filePath: string,
  currentCwd: NvimCwd,
  projectCwd: NvimCwd,
  gitignore: Gitignore,
): { safe: boolean; reason?: string } {
  const expandedPath = expandTilde(filePath);
  // Resolve the path relative to current working directory
  const absPath = resolveFilePath(
    currentCwd,
    expandedPath as UnresolvedFilePath,
  );

  // Check if within project cwd (the original project root)
  if (!absPath.startsWith(projectCwd + path.sep) && absPath !== projectCwd) {
    return {
      safe: false,
      reason: `path "${filePath}" is outside project directory`,
    };
  }

  // Check for hidden directories/files relative to project cwd
  const relPath = path.relative(projectCwd, absPath);
  if (relPath.split(path.sep).some((part) => part.startsWith("."))) {
    return {
      safe: false,
      reason: `path "${filePath}" contains hidden directory or file`,
    };
  }

  // Check if gitignored
  if (gitignore.ignores(relPath)) {
    return { safe: false, reason: `path "${filePath}" is gitignored` };
  }

  return { safe: true };
}

/** Check if a path is within a skills directory */
function isWithinSkillsDir(
  scriptPath: string,
  skillsPaths: string[],
  cwd: NvimCwd,
): boolean {
  const expandedScriptPath = expandTilde(scriptPath);
  const resolvedScript = resolveFilePath(
    cwd,
    expandedScriptPath as UnresolvedFilePath,
  );

  for (const skillsPath of skillsPaths) {
    const expandedSkillsPath = expandTilde(skillsPath);
    const resolvedSkillsPath = resolveFilePath(
      cwd,
      expandedSkillsPath as UnresolvedFilePath,
    );

    const normalizedSkillsPath = resolvedSkillsPath.endsWith(path.sep)
      ? resolvedSkillsPath
      : resolvedSkillsPath + path.sep;

    if (resolvedScript.startsWith(normalizedSkillsPath)) {
      return true;
    }
  }

  return false;
}

/** Check if script file exists and is a regular file */
function isExecutableScript(scriptPath: string, cwd: NvimCwd): boolean {
  try {
    const expandedPath = expandTilde(scriptPath);
    const resolvedPath = resolveFilePath(
      cwd,
      expandedPath as UnresolvedFilePath,
    );
    const stats = fs.statSync(resolvedPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/** Script runner patterns that can execute scripts */
const SCRIPT_RUNNERS: Record<string, RegExp> = {
  bash: /^(?:ba)?sh$/,
  zsh: /^zsh$/,
  python: /^python[23]?$/,
  node: /^(?:node|nodejs)$/,
  npx: /^npx$/,
};

/** Check if a command is executing a skills script */
function isSkillsScriptExecution(
  command: ParsedCommand,
  skillsPaths: string[],
  cwd: NvimCwd,
): boolean {
  if (skillsPaths.length === 0) {
    return false;
  }

  const { executable, args } = command;

  // Direct script execution: ./script.sh or /path/to/script
  if (
    executable.startsWith("./") ||
    executable.startsWith("/") ||
    executable.startsWith("~/")
  ) {
    if (isExecutableScript(executable, cwd)) {
      return isWithinSkillsDir(executable, skillsPaths, cwd);
    }
    return false;
  }

  // bash/sh/zsh script.sh
  if (
    SCRIPT_RUNNERS.bash.test(executable) ||
    SCRIPT_RUNNERS.zsh.test(executable)
  ) {
    if (args.length > 0) {
      const scriptPath = args[0];
      if (isExecutableScript(scriptPath, cwd)) {
        return isWithinSkillsDir(scriptPath, skillsPaths, cwd);
      }
    }
    return false;
  }

  // python script.py
  if (SCRIPT_RUNNERS.python.test(executable)) {
    if (args.length > 0) {
      const scriptPath = args[0];
      if (isExecutableScript(scriptPath, cwd)) {
        return isWithinSkillsDir(scriptPath, skillsPaths, cwd);
      }
    }
    return false;
  }

  // node script.js
  if (SCRIPT_RUNNERS.node.test(executable)) {
    if (args.length > 0) {
      const scriptPath = args[0];
      if (isExecutableScript(scriptPath, cwd)) {
        return isWithinSkillsDir(scriptPath, skillsPaths, cwd);
      }
    }
    return false;
  }

  // npx tsx script.ts
  if (SCRIPT_RUNNERS.npx.test(executable)) {
    if (args.length >= 2 && args[0] === "tsx") {
      const scriptPath = args[1];
      if (isExecutableScript(scriptPath, cwd)) {
        return isWithinSkillsDir(scriptPath, skillsPaths, cwd);
      }
    }
    return false;
  }

  return false;
}

/** Match arguments against an arg pattern */
function matchArgsPattern(
  args: string[],
  pattern: ArgSpec[],
  currentCwd: NvimCwd,
  projectCwd: NvimCwd,
  gitignore: Gitignore,
): { matches: boolean; reason?: string } {
  let argIndex = 0;
  let patternIndex = 0;

  while (patternIndex < pattern.length) {
    const spec = pattern[patternIndex];

    if (typeof spec === "string") {
      // Exact literal match
      if (argIndex >= args.length || args[argIndex] !== spec) {
        return { matches: false, reason: `expected argument "${spec}"` };
      }
      argIndex++;
      patternIndex++;
    } else if ("file" in spec) {
      // Single file argument
      if (argIndex >= args.length) {
        return { matches: false, reason: "expected file argument" };
      }
      const pathCheck = isPathSafe(
        args[argIndex],
        currentCwd,
        projectCwd,
        gitignore,
      );
      if (!pathCheck.safe) {
        return {
          matches: false,
          reason: pathCheck.reason ?? "invalid file path",
        };
      }
      argIndex++;
      patternIndex++;
    } else if ("any" in spec) {
      // Any single argument (wildcard)
      if (argIndex >= args.length) {
        return { matches: false, reason: "expected argument" };
      }
      argIndex++;
      patternIndex++;
    } else if ("pattern" in spec) {
      // Argument matching a regex pattern
      if (argIndex >= args.length) {
        return { matches: false, reason: "expected argument matching pattern" };
      }
      const regex = new RegExp(`^${spec.pattern}$`);
      if (!regex.test(args[argIndex])) {
        return {
          matches: false,
          reason: `argument "${args[argIndex]}" does not match pattern "${spec.pattern}"`,
        };
      }
      argIndex++;
      patternIndex++;
    } else if ("restFiles" in spec) {
      // Rest files - must be last in pattern
      if (patternIndex !== pattern.length - 1) {
        return { matches: false, reason: "restFiles must be last in pattern" };
      }
      // Check all remaining args are safe file paths
      while (argIndex < args.length) {
        const pathCheck = isPathSafe(
          args[argIndex],
          currentCwd,
          projectCwd,
          gitignore,
        );
        if (!pathCheck.safe) {
          return {
            matches: false,
            reason: pathCheck.reason ?? "invalid file path",
          };
        }
        argIndex++;
      }
      patternIndex++;
    }
  }

  // All args must be consumed
  if (argIndex < args.length) {
    return {
      matches: false,
      reason: `unexpected extra arguments: ${args.slice(argIndex).join(" ")}`,
    };
  }

  return { matches: true };
}

/** Check a single command against a command spec */
function checkCommandSpec(
  args: string[],
  spec: CommandSpec,
  currentCwd: NvimCwd,
  projectCwd: NvimCwd,
  gitignore: Gitignore,
): { allowed: boolean; reason?: string } {
  // Check subcommands first
  if (spec.subCommands && args.length > 0) {
    const subCommand = args[0];
    const subSpec = spec.subCommands[subCommand];
    if (subSpec) {
      return checkCommandSpec(
        args.slice(1),
        subSpec,
        currentCwd,
        projectCwd,
        gitignore,
      );
    }
  }

  // allowAll permits any arguments
  if (spec.allowAll) {
    return { allowed: true };
  }

  // Check arg patterns
  if (spec.args) {
    let lastReason: string | undefined;
    for (const pattern of spec.args) {
      const result = matchArgsPattern(
        args,
        pattern,
        currentCwd,
        projectCwd,
        gitignore,
      );
      if (result.matches) {
        return { allowed: true };
      }
      lastReason = result.reason;
    }
    return {
      allowed: false,
      reason: lastReason ?? "arguments do not match any allowed pattern",
    };
  }

  // No args specified means no additional args allowed
  if (args.length > 0) {
    return { allowed: false, reason: "no arguments allowed" };
  }

  return { allowed: true };
}

/** Process cd command and return new cwd */
function processCdCommand(
  command: ParsedCommand,
  currentCwd: NvimCwd,
): NvimCwd | undefined {
  if (command.executable !== "cd") {
    return undefined;
  }

  if (command.args.length === 0) {
    // cd with no args goes to home
    return os.homedir() as NvimCwd;
  }

  const targetDir = command.args[0];
  const expandedDir = expandTilde(targetDir);
  const newCwd = resolveFilePath(currentCwd, expandedDir as UnresolvedFilePath);

  return newCwd as NvimCwd;
}

export type PermissionCheckResult = {
  allowed: boolean;
  reason?: string;
};

/** Check if a parsed command list is allowed */
export function checkCommandListPermissions(
  commandList: ParsedCommandList,
  config: CommandPermissions,
  options: {
    cwd: NvimCwd;
    skillsPaths?: string[];
    gitignore: Gitignore;
  },
): PermissionCheckResult {
  const projectCwd = options.cwd;
  let currentCwd = options.cwd;
  const skillsPaths = options.skillsPaths ?? [];
  const gitignore = options.gitignore;

  for (const command of commandList.commands) {
    // Handle cd command - update cwd for subsequent commands
    const newCwd = processCdCommand(command, currentCwd);
    if (newCwd !== undefined) {
      currentCwd = newCwd;
      continue;
    }

    // Check if this is a skills script execution
    if (isSkillsScriptExecution(command, skillsPaths, currentCwd)) {
      continue;
    }

    // Look up command in config
    const commandSpec = config[command.executable];
    if (!commandSpec) {
      return {
        allowed: false,
        reason: `command "${command.executable}" is not in the allowlist`,
      };
    }

    const result = checkCommandSpec(
      command.args,
      commandSpec,
      currentCwd,
      projectCwd,
      gitignore,
    );
    if (!result.allowed) {
      return {
        allowed: false,
        reason: `command "${command.executable} ${command.args.join(" ")}": ${result.reason}`,
      };
    }
  }

  return { allowed: true };
}

/** Main entry point - check if a command string is allowed */
export function isCommandAllowedByConfig(
  command: string,
  config: CommandPermissions,
  options: {
    cwd: NvimCwd;
    skillsPaths?: string[];
    gitignore: Gitignore;
  },
): PermissionCheckResult {
  try {
    const parsed = parse(command);
    return checkCommandListPermissions(parsed, config, options);
  } catch (error) {
    if (error instanceof LexerError || error instanceof ParserError) {
      return {
        allowed: false,
        reason: `failed to parse command: ${error.message}`,
      };
    }
    throw error;
  }
}
