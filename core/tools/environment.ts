import type { Result } from "../utils/result.ts";
import type { AbsFilePath, UnresolvedFilePath } from "../utils/files.ts";
import type { ThreadId } from "../chat/types.ts";

// ============================================================================
// FileIO — abstraction over filesystem operations
// ============================================================================

export type DirEntry = {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
};

export interface FileIO {
  readFile(path: AbsFilePath): Promise<Result<string>>;
  writeFile(path: AbsFilePath, content: string): Promise<Result<void>>;
  fileExists(path: AbsFilePath): Promise<Result<boolean>>;
  mkdir(path: AbsFilePath): Promise<Result<void>>;
  readDir(path: AbsFilePath): Promise<Result<DirEntry[]>>;
}

// ============================================================================
// CommandExec — abstraction over shell command execution
// ============================================================================

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  signal: string | undefined;
  logFile: AbsFilePath | undefined;
};

export type OutputChunk = {
  stream: "stdout" | "stderr";
  text: string;
};

export type SpawnOptions = {
  cwd: AbsFilePath;
  timeout?: number;
  abortSignal?: AbortSignal;
  onOutput?: (chunk: OutputChunk) => void;
};

export interface CommandExec {
  spawn(command: string, options: SpawnOptions): Promise<Result<CommandResult>>;
}

// ============================================================================
// LspCapabilities — abstraction over language server protocol operations
// ============================================================================

export type LspPosition = {
  line: number;
  character: number;
};

export type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

export type HoverResult = {
  contents: string;
  range?: LspRange | undefined;
};

export type LocationResult = {
  filePath: AbsFilePath;
  range: LspRange;
};

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export type DiagnosticEntry = {
  filePath: AbsFilePath;
  range: LspRange;
  message: string;
  severity: DiagnosticSeverity;
  source?: string | undefined;
};

export type HoverParams = {
  filePath: UnresolvedFilePath;
  symbol: string;
  context?: string | undefined;
};

export type FindReferencesParams = {
  filePath: UnresolvedFilePath;
  symbol: string;
};

export interface LspCapabilities {
  hover(params: HoverParams): Promise<
    Result<{
      hover: HoverResult | undefined;
      definitions: LocationResult[];
      typeDefinitions: LocationResult[];
    }>
  >;

  findReferences(
    params: FindReferencesParams,
  ): Promise<Result<LocationResult[]>>;

  getDiagnostics(): Promise<Result<DiagnosticEntry[]>>;
}

// ============================================================================
// AgentControl — abstraction over thread/subagent management
// ============================================================================

export const AGENT_TYPES = ["default", "fast", "explore"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export type SubagentConfig = {
  prompt: string;
  contextFiles?: UnresolvedFilePath[] | undefined;
  agentType?: AgentType | undefined;
};

export type ThreadResult =
  | { status: "done"; result: string }
  | { status: "pending" };

export interface AgentControl {
  spawnSubagent(config: SubagentConfig): Promise<Result<ThreadId>>;
  getThreadResult(threadId: ThreadId): ThreadResult;
  getThreadSummary(threadId: ThreadId): string;
  compactThread(request: {
    summary: string;
    contextFiles?: string[] | undefined;
    continuation?: string | undefined;
  }): void;
}
