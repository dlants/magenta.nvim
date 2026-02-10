import * as path from "node:path";
import * as fs from "node:fs";
import type { ParsedCommand, ParsedCommandList } from "./parser.ts";
import { parse, ParserError } from "./parser.ts";
import { LexerError } from "./lexer.ts";
import {
  resolveFilePath,
  expandTilde,
  type NvimCwd,
  type UnresolvedFilePath,
  type AbsFilePath,
  type HomeDir,
  MAGENTA_TEMP_DIR,
} from "../../utils/files.ts";
import type { FilePermission } from "../../options.ts";
import {
  getEffectivePermissions,
  hasNewSecretSegment,
} from "../permissions.ts";

/** A single argument specification */
export type ArgSpec =
  | string // Exact literal argument
  | { type: "file" } // Single file path argument (checks both read and write - for backwards compat)
  | { type: "readFile" } // Single file path that will be read
  | { type: "writeFile" } // Single file path that will be written
  | { type: "restFiles" } // Zero or more file paths (must be last, checks read)
  | { type: "restAny" } // Zero or more arguments of any type (must be last)
  | { type: "any" } // Any single argument (wildcard)
  | { type: "pattern"; pattern: string } // Argument matching a regex pattern
  | { type: "group"; args: ArgSpec[]; optional?: boolean; anyOrder?: boolean };

/** Top-level command permissions configuration */
export type CommandPermissions = {
  commands: ArgSpec[][]; // Array of allowed command patterns (e.g. ['git', 'status', {type: 'restAny'}])
  pipeCommands: ArgSpec[][]; // Array of allowed patterns when receiving pipe input
};

/** Builtin command permissions - always allowed */
export const BUILTIN_COMMAND_PERMISSIONS: CommandPermissions = {
  commands: [
    // Basic commands
    ["ls", { type: "restAny" }],
    ["pwd"],
    ["echo", { type: "restAny" }],
    ["cat", { type: "readFile" }],
    // head: with optional -n flag or pattern like -10, plus file
    [
      "head",
      { type: "group", args: ["-n", { type: "any" }], optional: true },
      { type: "readFile" },
    ],
    ["head", { type: "pattern", pattern: "-[0-9]+" }, { type: "readFile" }],
    // tail: with optional -n flag or pattern like -10, plus file
    [
      "tail",
      { type: "group", args: ["-n", { type: "any" }], optional: true },
      { type: "readFile" },
    ],
    ["tail", { type: "pattern", pattern: "-[0-9]+" }, { type: "readFile" }],
    // wc: optional -l flag plus file
    [
      "wc",
      { type: "group", args: ["-l"], optional: true },
      { type: "readFile" },
    ],
    // grep: optional -i, pattern, restFiles
    [
      "grep",
      { type: "group", args: ["-i"], optional: true },
      { type: "any" },
      { type: "restFiles" },
    ],
    // sort: file (read-only)
    ["sort", { type: "readFile" }],
    // uniq: file (read-only)
    ["uniq", { type: "readFile" }],
    // cut: with delim, field, file (read-only)
    ["cut", "-d", { type: "any" }, "-f", { type: "any" }, { type: "readFile" }],
    // awk: pattern, file (read-only)
    ["awk", { type: "any" }, { type: "readFile" }],
    // sed: pattern, file (read-only, no -i flag)
    ["sed", { type: "any" }, { type: "readFile" }],
    // git subcommands
    ["git", "status", { type: "restAny" }],
    ["git", "log", { type: "restAny" }],
    ["git", "diff", { type: "restAny" }],
    ["git", "show", { type: "restAny" }],
    ["git", "add", { type: "restAny" }],
    ["git", "commit", { type: "restAny" }],
    ["git", "push", { type: "restAny" }],
    ["git", "reset", { type: "restAny" }],
    ["git", "restore", { type: "restAny" }],
    ["git", "branch", { type: "restAny" }],
    ["git", "checkout", { type: "restAny" }],
    ["git", "switch", { type: "restAny" }],
    ["git", "fetch", { type: "restAny" }],
    ["git", "pull", { type: "restAny" }],
    ["git", "merge", { type: "restAny" }],
    ["git", "rebase", { type: "restAny" }],
    ["git", "tag", { type: "restAny" }],
    ["git", "stash", { type: "restAny" }],
    // ripgrep: [optional -l] pattern [optional --type ext] [files...]
    [
      "rg",
      { type: "group", args: ["-l"], optional: true },
      { type: "any" },
      { type: "group", args: ["--type", { type: "any" }], optional: true },
      { type: "restFiles" },
    ],
    // fd: [optional -t f|d] [optional -e ext] [optional pattern] [dirs...]
    [
      "fd",
      { type: "group", args: ["-t", { type: "any" }], optional: true },
      { type: "group", args: ["-e", { type: "any" }], optional: true },
      { type: "group", args: [{ type: "any" }], optional: true },
      { type: "restFiles" },
    ],
  ],
  pipeCommands: [
    ["awk", { type: "restAny" }],
    ["cut", { type: "restAny" }],
    ["grep", { type: "restAny" }],
    ["head", { type: "restAny" }],
    ["rg", { type: "restAny" }],
    ["sed", { type: "restAny" }],
    ["sort", { type: "restAny" }],
    ["tail", { type: "restAny" }],
    ["tr", { type: "restAny" }],
    ["uniq", { type: "restAny" }],
    ["wc", { type: "restAny" }],
    ["xargs", { type: "restAny" }],
  ],
};

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}

/**
 * Check if a file requires secret permissions (has hidden segments after all applicable permission paths).
 * This is a local version for the bash parser to avoid circular dependency issues.
 */
function fileRequiresSecretPermission(
  absFilePath: AbsFilePath,
  filePermissions: FilePermission[],
  cwd: NvimCwd,
  homeDir: HomeDir,
): boolean {
  // Check the absolute path segments for hidden segments
  const pathSegments = absFilePath.split(path.sep).filter((s) => s.length > 0);
  if (!pathSegments.some((segment) => segment.startsWith("."))) {
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
      // If there are no new secret segments after this permission path, then the file
      // can be accessed without secret permission via this rule
      if (!hasNewSecretSegment(absFilePath, perm.path, cwd, homeDir)) {
        return false;
      }
    }
  }

  // All covering permission paths have new secret segments after them
  return true;
}

/** Check if a path can be read (using the filePermissions system) */
function canReadPath(
  filePath: string,
  currentCwd: NvimCwd,
  projectCwd: NvimCwd,
  filePermissions: FilePermission[],
  homeDir: HomeDir,
): { safe: boolean; reason?: string } {
  const expandedPath = expandTilde(filePath, homeDir);
  // Resolve the path relative to current working directory
  const absPath = resolveFilePath(
    currentCwd,
    expandedPath as UnresolvedFilePath,
    homeDir,
  );

  // Magenta temp files (e.g., bash command logs) are always safe
  if (absPath.startsWith(MAGENTA_TEMP_DIR + path.sep)) {
    return { safe: true };
  }

  // Get effective permissions from filePermissions config
  const effectivePerms = getEffectivePermissions(
    absPath,
    filePermissions,
    projectCwd,
    homeDir,
  );

  // Check if this file requires secret permissions
  const needsSecret = fileRequiresSecretPermission(
    absPath,
    filePermissions,
    projectCwd,
    homeDir,
  );

  if (needsSecret) {
    if (!effectivePerms.readSecret) {
      return {
        safe: false,
        reason: `path "${filePath}" is a secret file (requires readSecret permission)`,
      };
    }
  } else {
    if (!effectivePerms.read && !effectivePerms.readSecret) {
      return {
        safe: false,
        reason: `path "${filePath}" is not readable (no read permission)`,
      };
    }
  }

  return { safe: true };
}

/** Check if a path can be written (using the filePermissions system) */
function canWritePath(
  filePath: string,
  currentCwd: NvimCwd,
  projectCwd: NvimCwd,
  filePermissions: FilePermission[],
  homeDir: HomeDir,
): { safe: boolean; reason?: string } {
  const expandedPath = expandTilde(filePath, homeDir);
  // Resolve the path relative to current working directory
  const absPath = resolveFilePath(
    currentCwd,
    expandedPath as UnresolvedFilePath,
    homeDir,
  );

  // Get effective permissions from filePermissions config
  const effectivePerms = getEffectivePermissions(
    absPath,
    filePermissions,
    projectCwd,
    homeDir,
  );

  // Check if this file requires secret permissions
  const needsSecret = fileRequiresSecretPermission(
    absPath,
    filePermissions,
    projectCwd,
    homeDir,
  );

  if (needsSecret) {
    if (!effectivePerms.writeSecret) {
      return {
        safe: false,
        reason: `path "${filePath}" is a secret file (requires writeSecret permission)`,
      };
    }
  } else {
    if (!effectivePerms.write && !effectivePerms.writeSecret) {
      return {
        safe: false,
        reason: `path "${filePath}" is not writable (no write permission)`,
      };
    }
  }

  return { safe: true };
}

/** Legacy: Check if a path is safe for both read and write (for backwards compatibility with { type: "file" }) */
function isPathSafe(
  filePath: string,
  currentCwd: NvimCwd,
  projectCwd: NvimCwd,
  filePermissions: FilePermission[],
  homeDir: HomeDir,
): { safe: boolean; reason?: string } {
  // For legacy { type: "file" }, we check both read and write permissions
  const readResult = canReadPath(
    filePath,
    currentCwd,
    projectCwd,
    filePermissions,
    homeDir,
  );
  if (!readResult.safe) {
    return readResult;
  }

  const writeResult = canWritePath(
    filePath,
    currentCwd,
    projectCwd,
    filePermissions,
    homeDir,
  );
  if (!writeResult.safe) {
    return writeResult;
  }

  return { safe: true };
}

/** Check if a path is within a skills directory */
function isWithinSkillsDir(
  scriptPath: string,
  skillsPaths: string[],
  cwd: NvimCwd,
  homeDir: HomeDir,
): boolean {
  const expandedScriptPath = expandTilde(scriptPath, homeDir);
  const resolvedScript = resolveFilePath(
    cwd,
    expandedScriptPath as UnresolvedFilePath,
    homeDir,
  );

  for (const skillsPath of skillsPaths) {
    const expandedSkillsPath = expandTilde(skillsPath, homeDir);
    const resolvedSkillsPath = resolveFilePath(
      cwd,
      expandedSkillsPath as UnresolvedFilePath,
      homeDir,
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
function isExecutableScript(
  scriptPath: string,
  cwd: NvimCwd,
  homeDir: HomeDir,
): boolean {
  try {
    const expandedPath = expandTilde(scriptPath, homeDir);
    const resolvedPath = resolveFilePath(
      cwd,
      expandedPath as UnresolvedFilePath,
      homeDir,
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
  pkgx: /^pkgx$/,
};

/** Check if a command is executing a skills script */
function isSkillsScriptExecution(
  command: ParsedCommand,
  skillsPaths: string[],
  cwd: NvimCwd,
  homeDir: HomeDir,
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
    if (isExecutableScript(executable, cwd, homeDir)) {
      return isWithinSkillsDir(executable, skillsPaths, cwd, homeDir);
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
      if (isExecutableScript(scriptPath, cwd, homeDir)) {
        return isWithinSkillsDir(scriptPath, skillsPaths, cwd, homeDir);
      }
    }
    return false;
  }

  // python script.py
  if (SCRIPT_RUNNERS.python.test(executable)) {
    if (args.length > 0) {
      const scriptPath = args[0];
      if (isExecutableScript(scriptPath, cwd, homeDir)) {
        return isWithinSkillsDir(scriptPath, skillsPaths, cwd, homeDir);
      }
    }
    return false;
  }

  // node script.js
  if (SCRIPT_RUNNERS.node.test(executable)) {
    if (args.length > 0) {
      const scriptPath = args[0];
      if (isExecutableScript(scriptPath, cwd, homeDir)) {
        return isWithinSkillsDir(scriptPath, skillsPaths, cwd, homeDir);
      }
    }
    return false;
  }

  // npx tsx script.ts
  if (SCRIPT_RUNNERS.npx.test(executable)) {
    if (args.length >= 2 && args[0] === "tsx") {
      const scriptPath = args[1];
      if (isExecutableScript(scriptPath, cwd, homeDir)) {
        return isWithinSkillsDir(scriptPath, skillsPaths, cwd, homeDir);
      }
    }
    return false;
  }

  // pkgx <interpreter> script.ext (e.g., pkgx tsx script.ts, pkgx python script.py)
  if (SCRIPT_RUNNERS.pkgx.test(executable)) {
    if (args.length >= 2) {
      const interpreter = args[0];
      // Check if the interpreter is a known script runner
      if (
        interpreter === "tsx" ||
        SCRIPT_RUNNERS.python.test(interpreter) ||
        SCRIPT_RUNNERS.node.test(interpreter) ||
        SCRIPT_RUNNERS.bash.test(interpreter) ||
        SCRIPT_RUNNERS.zsh.test(interpreter)
      ) {
        const scriptPath = args[1];
        if (isExecutableScript(scriptPath, cwd, homeDir)) {
          return isWithinSkillsDir(scriptPath, skillsPaths, cwd, homeDir);
        }
      }
    }
    return false;
  }

  return false;
}

type MatchContext = {
  currentCwd: NvimCwd;
  projectCwd: NvimCwd;
  filePermissions: FilePermission[];
  homeDir: HomeDir;
};

type NonGroupArgSpec = Exclude<
  ArgSpec,
  { type: "group"; args: ArgSpec[]; optional?: boolean; anyOrder?: boolean }
>;

/** Try to match a single non-group spec at the current position. Returns number of args consumed or error. */
function matchSingleSpec(
  args: string[],
  argIndex: number,
  spec: NonGroupArgSpec,
  ctx: MatchContext,
): { consumed: number } | { error: string } {
  if (typeof spec === "string") {
    if (argIndex >= args.length || args[argIndex] !== spec) {
      return { error: `expected argument "${spec}"` };
    }
    return { consumed: 1 };
  }

  switch (spec.type) {
    case "file": {
      // Legacy: checks both read and write for backwards compatibility
      if (argIndex >= args.length) {
        return { error: "expected file argument" };
      }
      const pathCheck = isPathSafe(
        args[argIndex],
        ctx.currentCwd,
        ctx.projectCwd,
        ctx.filePermissions,
        ctx.homeDir,
      );
      if (!pathCheck.safe) {
        return { error: pathCheck.reason ?? "invalid file path" };
      }
      return { consumed: 1 };
    }

    case "readFile": {
      if (argIndex >= args.length) {
        return { error: "expected file argument" };
      }
      const pathCheck = canReadPath(
        args[argIndex],
        ctx.currentCwd,
        ctx.projectCwd,
        ctx.filePermissions,
        ctx.homeDir,
      );
      if (!pathCheck.safe) {
        return { error: pathCheck.reason ?? "invalid file path" };
      }
      return { consumed: 1 };
    }

    case "writeFile": {
      if (argIndex >= args.length) {
        return { error: "expected file argument" };
      }
      const pathCheck = canWritePath(
        args[argIndex],
        ctx.currentCwd,
        ctx.projectCwd,
        ctx.filePermissions,
        ctx.homeDir,
      );
      if (!pathCheck.safe) {
        return { error: pathCheck.reason ?? "invalid file path" };
      }
      return { consumed: 1 };
    }

    case "any": {
      if (argIndex >= args.length) {
        return { error: "expected argument" };
      }
      return { consumed: 1 };
    }

    case "pattern": {
      if (argIndex >= args.length) {
        return { error: "expected argument matching pattern" };
      }
      const regex = new RegExp(`^${spec.pattern}$`);
      if (!regex.test(args[argIndex])) {
        return {
          error: `argument "${args[argIndex]}" does not match pattern "${spec.pattern}"`,
        };
      }
      return { consumed: 1 };
    }

    case "restFiles": {
      // Check read permission for all remaining files
      let consumed = 0;
      while (argIndex + consumed < args.length) {
        const pathCheck = canReadPath(
          args[argIndex + consumed],
          ctx.currentCwd,
          ctx.projectCwd,
          ctx.filePermissions,
          ctx.homeDir,
        );
        if (!pathCheck.safe) {
          return { error: pathCheck.reason ?? "invalid file path" };
        }
        consumed++;
      }
      return { consumed };
    }

    case "restAny": {
      // Consume all remaining arguments
      return { consumed: args.length - argIndex };
    }
  }
}

/** Try to match a group's args sequentially. Returns number of args consumed or error. */
function matchGroupSequential(
  args: string[],
  argIndex: number,
  specs: ArgSpec[],
  ctx: MatchContext,
): { consumed: number } | { error: string } {
  let tempIndex = argIndex;

  for (const spec of specs) {
    if (typeof spec === "object" && "type" in spec && spec.type === "group") {
      const result = matchGroup(args, tempIndex, spec, ctx);
      if ("error" in result) {
        return result;
      }
      tempIndex += result.consumed;
    } else if (
      typeof spec === "object" &&
      "type" in spec &&
      spec.type === "restFiles"
    ) {
      return { error: "restFiles not allowed inside group" };
    } else if (
      typeof spec === "object" &&
      "type" in spec &&
      spec.type === "restAny"
    ) {
      return { error: "restAny not allowed inside group" };
    } else {
      const result = matchSingleSpec(
        args,
        tempIndex,
        spec as NonGroupArgSpec,
        ctx,
      );
      if ("error" in result) {
        return result;
      }
      tempIndex += result.consumed;
    }
  }

  return { consumed: tempIndex - argIndex };
}

/** Try to match a group's args in any order. Returns number of args consumed or error. */
function matchGroupAnyOrder(
  args: string[],
  argIndex: number,
  specs: ArgSpec[],
  ctx: MatchContext,
): { consumed: number } | { error: string } {
  const remaining = [...specs];
  let tempIndex = argIndex;

  while (remaining.length > 0 && tempIndex < args.length) {
    let matched = false;

    for (let i = 0; i < remaining.length; i++) {
      const spec = remaining[i];
      let result: { consumed: number } | { error: string };

      if (typeof spec === "object" && "type" in spec && spec.type === "group") {
        result = matchGroup(args, tempIndex, spec, ctx);
      } else if (
        typeof spec === "object" &&
        "type" in spec &&
        spec.type === "restFiles"
      ) {
        return { error: "restFiles not allowed inside group" };
      } else if (
        typeof spec === "object" &&
        "type" in spec &&
        spec.type === "restAny"
      ) {
        return { error: "restAny not allowed inside group" };
      } else {
        result = matchSingleSpec(args, tempIndex, spec as NonGroupArgSpec, ctx);
      }

      if (!("error" in result) && result.consumed > 0) {
        tempIndex += result.consumed;
        remaining.splice(i, 1);
        matched = true;
        break;
      }
    }

    if (!matched) {
      break;
    }
  }

  // Check if all non-optional specs were matched
  for (const spec of remaining) {
    if (typeof spec === "object" && "type" in spec && spec.type === "group") {
      if (!spec.optional) {
        return { error: "required group not matched" };
      }
    } else {
      return { error: "required argument not matched" };
    }
  }

  return { consumed: tempIndex - argIndex };
}

/** Try to match a group. Returns number of args consumed or error. */
function matchGroup(
  args: string[],
  argIndex: number,
  spec: {
    type: "group";
    args: ArgSpec[];
    optional?: boolean;
    anyOrder?: boolean;
  },
  ctx: MatchContext,
): { consumed: number } | { error: string } {
  const result = spec.anyOrder
    ? matchGroupAnyOrder(args, argIndex, spec.args, ctx)
    : matchGroupSequential(args, argIndex, spec.args, ctx);

  if ("error" in result) {
    // Structural errors should always propagate
    if (result.error.includes("restFiles not allowed inside group")) {
      return result;
    }
    if (spec.optional) {
      return { consumed: 0 };
    }
    return result;
  }

  return result;
}

/** Match arguments against an arg pattern */
function matchArgsPattern(
  args: string[],
  pattern: ArgSpec[],
  currentCwd: NvimCwd,
  projectCwd: NvimCwd,
  filePermissions: FilePermission[],
  homeDir: HomeDir,
): { matches: boolean; reason?: string } {
  let argIndex = 0;
  let patternIndex = 0;
  const ctx: MatchContext = {
    currentCwd,
    projectCwd,
    filePermissions,
    homeDir,
  };

  while (patternIndex < pattern.length) {
    const spec = pattern[patternIndex];

    if (typeof spec === "object" && "type" in spec && spec.type === "group") {
      const result = matchGroup(args, argIndex, spec, ctx);
      if ("error" in result) {
        return { matches: false, reason: result.error };
      }
      argIndex += result.consumed;
      patternIndex++;
    } else if (
      typeof spec === "object" &&
      "type" in spec &&
      spec.type === "restFiles"
    ) {
      // Rest files - must be last in pattern
      if (patternIndex !== pattern.length - 1) {
        return { matches: false, reason: "restFiles must be last in pattern" };
      }
      const result = matchSingleSpec(args, argIndex, spec, ctx);
      if ("error" in result) {
        return { matches: false, reason: result.error };
      }
      argIndex += result.consumed;
      patternIndex++;
    } else if (
      typeof spec === "object" &&
      "type" in spec &&
      spec.type === "restAny"
    ) {
      // Rest any - must be last in pattern
      if (patternIndex !== pattern.length - 1) {
        return { matches: false, reason: "restAny must be last in pattern" };
      }
      const result = matchSingleSpec(args, argIndex, spec, ctx);
      if ("error" in result) {
        return { matches: false, reason: result.error };
      }
      argIndex += result.consumed;
      patternIndex++;
    } else {
      const result = matchSingleSpec(
        args,
        argIndex,
        spec as NonGroupArgSpec,
        ctx,
      );
      if ("error" in result) {
        return { matches: false, reason: result.error };
      }
      argIndex += result.consumed;
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

/** Check a single command against the command permissions */
function checkCommand(
  executable: string,
  args: string[],
  config: CommandPermissions,
  currentCwd: NvimCwd,
  projectCwd: NvimCwd,
  filePermissions: FilePermission[],
  receivingPipe: boolean,
  homeDir: HomeDir,
): { allowed: boolean; reason?: string } {
  // Build full command array: [executable, ...args]
  const fullCommand = [executable, ...args];

  // Choose which patterns to use based on pipe status
  const patterns = receivingPipe ? config.pipeCommands : config.commands;

  // Try each pattern
  let lastReason: string | undefined;
  for (const pattern of patterns) {
    const result = matchArgsPattern(
      fullCommand,
      pattern,
      currentCwd,
      projectCwd,
      filePermissions,
      homeDir,
    );
    if (result.matches) {
      return { allowed: true };
    }
    lastReason = result.reason;
  }

  return {
    allowed: false,
    reason:
      lastReason ??
      `command "${executable}" does not match any allowed pattern`,
  };
}

/** Process cd command and return new cwd */
function processCdCommand(
  command: ParsedCommand,
  currentCwd: NvimCwd,
  homeDir: HomeDir,
): NvimCwd | undefined {
  if (command.executable !== "cd") {
    return undefined;
  }

  if (command.args.length === 0) {
    // cd with no args goes to home
    return homeDir as unknown as NvimCwd;
  }

  const targetDir = command.args[0];
  const expandedDir = expandTilde(targetDir, homeDir);
  const newCwd = resolveFilePath(
    currentCwd,
    expandedDir as UnresolvedFilePath,
    homeDir,
  );

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
    homeDir: HomeDir;
    skillsPaths?: string[];
    filePermissions?: FilePermission[];
  },
): PermissionCheckResult {
  const projectCwd = options.cwd;
  let currentCwd = options.cwd;
  const homeDir = options.homeDir;
  const skillsPaths = options.skillsPaths ?? [];
  const filePermissions = options.filePermissions ?? [];

  for (const command of commandList.commands) {
    // Handle cd command - update cwd for subsequent commands
    const newCwd = processCdCommand(command, currentCwd, homeDir);
    if (newCwd !== undefined) {
      currentCwd = newCwd;
      continue;
    }

    // Check if this is a skills script execution
    if (isSkillsScriptExecution(command, skillsPaths, currentCwd, homeDir)) {
      continue;
    }

    const result = checkCommand(
      command.executable,
      command.args,
      config,
      currentCwd,
      projectCwd,
      filePermissions,
      command.receivingPipe,
      homeDir,
    );
    if (!result.allowed) {
      return {
        allowed: false,
        reason: `command "${command.executable} ${command.args.join(" ")}": ${result.reason}`,
      };
    }

    for (const redirect of command.fileRedirects) {
      if (redirect.target !== "/dev/null") {
        return {
          allowed: false,
          reason: `file redirection to "${redirect.target}" is not auto-approved`,
        };
      }
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
    homeDir: HomeDir;
    skillsPaths?: string[];
    filePermissions?: FilePermission[];
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
