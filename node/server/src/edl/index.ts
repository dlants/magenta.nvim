import type { FileIO } from "../capabilities/file-io.ts";
import { type HomeDir, type NvimCwd, resolveFilePath } from "../utils/files.ts";
import { ExecutionError, Executor } from "./executor.ts";
import { lexWithPos, ParseError, parse } from "./parser.ts";
import type {
  FileMutationSummary,
  Pos,
  RangeWithPos,
  ScriptResult,
  TraceEntry,
} from "./types.ts";

export { parse, ParseError, ExecutionError, Executor };
export type { FileMutationSummary, ScriptResult, TraceEntry } from "./types.ts";

export type EdlRegisters = {
  registers: Map<string, string>;
  nextSavedId: number;
};
export type RangeInfo = {
  startPos: Pos;
  endPos: Pos;
  content: string;
};

export type FileErrorInfo = {
  path: string;
  error: string;
  failedMutations: number;
  failedCommands: string[];
  trace: { command: string; snippet: string }[];
  savedRegisters: { name: string; sizeChars: number }[];
};

export type EdlResultData = {
  warnings: string[];
  trace: { command: string; snippet: string }[];
  mutations: {
    path: string;
    summary: FileMutationSummary;
    content: string;
    previousContent: string;
  }[];
  finalSelection: { ranges: RangeInfo[] } | undefined;
  fileErrors: FileErrorInfo[];
};

export type RunScriptResult =
  | {
      status: "ok";
      data: EdlResultData;
      formatted: string;
      edlRegisters: EdlRegisters;
    }
  | { status: "error"; error: string };

function formatTrace(trace: TraceEntry[]): string {
  if (trace.length === 0) return "";
  return trace.map((t) => `  ${t.command} → ${t.snippet}`).join("\n");
}

function formatMutations(mutations: Map<string, FileMutationSummary>): string {
  if (mutations.size === 0) return "No files modified.";
  const lines: string[] = [];
  for (const [path, m] of mutations) {
    const parts: string[] = [];
    if (m.replacements > 0) parts.push(`${m.replacements} replacements`);
    if (m.insertions > 0) parts.push(`${m.insertions} insertions`);
    if (m.deletions > 0) parts.push(`${m.deletions} deletions`);
    parts.push(`+${m.linesAdded}/-${m.linesRemoved} lines`);
    lines.push(`  ${path}: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

export type FileAccessInfo = {
  path: string;
  read: boolean;
  write: boolean;
};

const MUTATION_COMMANDS = new Set([
  "replace",
  "delete",
  "insert_before",
  "insert_after",
  "cut",
]);

export function analyzeFileAccess(script: string): FileAccessInfo[] {
  const commands = parse(script);
  const fileAccess = new Map<string, { read: boolean; write: boolean }>();
  let currentFile: string | undefined;

  for (const cmd of commands) {
    if (cmd.type === "file") {
      currentFile = cmd.path;
      if (!fileAccess.has(cmd.path)) {
        fileAccess.set(cmd.path, { read: true, write: false });
      }
    } else if (cmd.type === "newfile") {
      currentFile = cmd.path;
      fileAccess.set(cmd.path, { read: false, write: true });
    } else if (MUTATION_COMMANDS.has(cmd.type) && currentFile) {
      const access = fileAccess.get(currentFile);
      if (access) {
        access.write = true;
      }
    }
  }

  return Array.from(fileAccess.entries()).map(([path, access]) => ({
    path,
    ...access,
  }));
}
export type ScriptFileSegment = { path: string; segment: string };

/**
 * Display-only, tolerant per-file splitter. Given a (possibly partial/streaming)
 * script, returns one entry per `file`/`newfile` directive with the raw script
 * substring belonging to that directive (up to the next directive). Heredoc-aware
 * and never throws. Commands before the first directive are dropped.
 */
export function splitScriptByFile(script: string): ScriptFileSegment[] {
  const boundaries: { path: string; start: number }[] = [];
  const tokens = Array.from(lexWithPos(script));

  for (let i = 0; i < tokens.length; i++) {
    const { token } = tokens[i];
    if (
      token.type === "word" &&
      (token.value === "file" || token.value === "newfile")
    ) {
      const pathTok = tokens[i + 1]?.token;
      if (pathTok && (pathTok.type === "path" || pathTok.type === "word")) {
        boundaries.push({ path: pathTok.value, start: tokens[i].start });
      }
    }
  }

  return boundaries.map((b, idx) => {
    const end =
      idx + 1 < boundaries.length ? boundaries[idx + 1].start : script.length;
    return { path: b.path, segment: script.slice(b.start, end) };
  });
}

function formatPos(pos: Pos): string {
  return `${pos.line}:${pos.col}`;
}

const MAX_CONTENT_CHARS = 800;

function abridgeContent(content: string): string {
  if (content.length <= MAX_CONTENT_CHARS) {
    return content;
  }
  const half = Math.floor((MAX_CONTENT_CHARS - 5) / 2);
  return `${content.slice(0, half)}\n...\n${content.slice(-half)}`;
}

function formatRangeInfo(r: RangeWithPos): string {
  const posInfo = `[${formatPos(r.startPos)} - ${formatPos(r.endPos)}]`;
  const abridged = abridgeContent(r.content);
  return `${posInfo}\n${abridged}`;
}

function formatFileErrors(
  fileErrors: ScriptResult["fileErrors"],
): string | undefined {
  if (fileErrors.length === 0) return undefined;
  const lines: string[] = [];
  for (const fe of fileErrors) {
    lines.push(
      `  ${fe.path}: ${fe.error} (${fe.failedMutations} mutation${fe.failedMutations !== 1 ? "s" : ""} not applied)`,
    );
    if (fe.failedCommands.length > 0) {
      lines.push(
        `    Failed commands (${fe.failedCommands.length}):\n${fe.failedCommands.map((c) => c.replace(/^/gm, "      ")).join("\n")}`,
      );
    }
    if (fe.trace.length > 0) {
      lines.push(
        `    Trace:\n${fe.trace.map((t) => `      ${t.command} → ${t.snippet}`).join("\n")}`,
      );
    }
    for (const reg of fe.savedRegisters) {
      lines.push(
        `    Text saved to register ${reg.name} (${reg.sizeChars} chars). Use \`replace ${reg.name}\` to reference it.`,
      );
    }
  }
  return lines.join("\n");
}
function formatResult(result: ScriptResult): string {
  const sections: string[] = [];

  if (result.warnings.length > 0) {
    sections.push(
      `Warnings:\n${result.warnings.map((w) => `  ${w}`).join("\n")}`,
    );
  }

  sections.push(`Trace:\n${formatTrace(result.trace)}`);

  sections.push(`Mutations:\n${formatMutations(result.mutations)}`);

  if (result.finalSelection) {
    const rangeStrs = result.finalSelection.ranges.map(
      (r, i) => `  Range ${i + 1}: ${formatRangeInfo(r)}`,
    );
    sections.push(
      `Final selection (${result.finalSelection.ranges.length} ranges):\n${rangeStrs.join("\n\n")}`,
    );
  }

  const fileErrorsStr = formatFileErrors(result.fileErrors);
  if (fileErrorsStr) {
    sections.push(`File errors:\n${fileErrorsStr}`);
  }

  return sections.join("\n\n");
}

export async function runScript(
  script: string,
  fileIO?: FileIO,
  edlRegisters?: EdlRegisters,
  pathContext?: { cwd: NvimCwd; homeDir: HomeDir },
): Promise<RunScriptResult> {
  const toDisplayPath = (p: string): string =>
    pathContext
      ? resolveFilePath(
          pathContext.cwd,
          p as Parameters<typeof resolveFilePath>[1],
          pathContext.homeDir,
        )
      : p;
  try {
    const commands = parse(script);
    const executor = new Executor(fileIO);
    if (edlRegisters) {
      for (const [key, value] of edlRegisters.registers) {
        executor.registers.set(key, value);
      }
      executor.savedRegisterCount = edlRegisters.nextSavedId;
    }
    const result = await executor.execute(commands);

    const data: EdlResultData = {
      warnings: result.warnings,
      trace: result.trace.map((t) => ({
        command: t.command,
        snippet: t.snippet,
      })),
      mutations: Array.from(result.mutations.entries()).map(
        ([path, summary]) => ({
          path: toDisplayPath(path),
          summary,
          content: result.fileContents.get(path)?.content ?? "",
          previousContent: result.fileContents.get(path)?.previousContent ?? "",
        }),
      ),
      finalSelection: result.finalSelection
        ? {
            ranges: result.finalSelection.ranges.map((r) => ({
              startPos: r.startPos,
              endPos: r.endPos,
              content: abridgeContent(r.content),
            })),
          }
        : undefined,
      fileErrors: result.fileErrors.map((fe) => ({
        path: toDisplayPath(fe.path),
        error: fe.error,
        failedMutations: fe.failedMutations,
        failedCommands: fe.failedCommands,
        trace: fe.trace.map((t) => ({
          command: t.command,
          snippet: t.snippet,
        })),
        savedRegisters: fe.savedRegisters,
      })),
    };

    const updatedRegisters: EdlRegisters = {
      registers: new Map(executor.registers),
      nextSavedId: executor.savedRegisterCount,
    };

    return {
      status: "ok",
      data,
      formatted: formatResult({
        ...result,
        mutations: new Map(
          Array.from(result.mutations, ([p, m]) => [toDisplayPath(p), m]),
        ),
        fileErrors: result.fileErrors.map((fe) => ({
          ...fe,
          path: toDisplayPath(fe.path),
        })),
      }),
      edlRegisters: updatedRegisters,
    };
  } catch (e) {
    if (e instanceof ParseError) {
      return { status: "error", error: `Parse error: ${e.message}` };
    }
    if (e instanceof ExecutionError) {
      const sections: string[] = [`Error: ${e.message}`];
      if (e.trace.length > 0) {
        sections.push(`Trace:\n${formatTrace(e.trace)}`);
      }
      return { status: "error", error: sections.join("\n\n") };
    }
    return {
      status: "error",
      error: `Unexpected error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
