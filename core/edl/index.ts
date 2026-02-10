import { parse, ParseError } from "./parser.ts";
import { Executor, ExecutionError } from "./executor.ts";
import type { FileIO } from "./file-io.ts";
import type {
  ScriptResult,
  TraceEntry,
  FileMutationSummary,
  RangeWithPos,
  Pos,
} from "./types.ts";

export { parse, ParseError, ExecutionError, Executor };
export type { ScriptResult, TraceEntry, FileMutationSummary } from "./types.ts";

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
  trace: { command: string; snippet: string }[];
  savedRegisters: { name: string; sizeChars: number }[];
};

export type EdlResultData = {
  trace: { command: string; snippet: string }[];
  mutations: { path: string; summary: FileMutationSummary; content: string }[];
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
function formatPos(pos: Pos): string {
  return `${pos.line}:${pos.col}`;
}

const MAX_CONTENT_CHARS = 800;

function abridgeContent(content: string): string {
  if (content.length <= MAX_CONTENT_CHARS) {
    return content;
  }
  const half = Math.floor((MAX_CONTENT_CHARS - 5) / 2);
  return content.slice(0, half) + "\n...\n" + content.slice(-half);
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
    lines.push(`  ${fe.path}: ${fe.error}`);
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
  fileIO: FileIO,
  edlRegisters?: EdlRegisters,
): Promise<RunScriptResult> {
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
      trace: result.trace.map((t) => ({
        command: t.command,
        snippet: t.snippet,
      })),
      mutations: Array.from(result.mutations.entries()).map(
        ([path, summary]) => ({
          path,
          summary,
          content: result.fileContents.get(path) ?? "",
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
        path: fe.path,
        error: fe.error,
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
      formatted: formatResult(result),
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
