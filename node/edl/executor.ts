import { type FileIO, FsFileIO } from "./file-io.ts";
import { Document } from "./document.ts";
import type { Command, MutationText, Pattern } from "./parser.ts";
import type {
  FileError,
  FileMutationSummary,
  Range,
  RangeWithPos,
  SavedRegisterInfo,
  ScriptResult,
  TraceEntry,
} from "./types.ts";

export class ExecutionError extends Error {
  constructor(
    message: string,
    public trace: TraceEntry[] = [],
  ) {
    super(message);
  }
}

const MAX_SNIPPET_LENGTH = 120;

function formatPattern(pattern: Pattern): string {
  switch (pattern.type) {
    case "regex":
      return `/${pattern.pattern.source}/${pattern.pattern.flags.replace("g", "")}`;
    case "literal": {
      const text = pattern.text;
      if (text.length > 60) {
        return `<<HEREDOC\n${text.slice(0, 60)}...\nHEREDOC`;
      }
      return `<<HEREDOC\n${text}\nHEREDOC`;
    }
    case "line":
      return `${pattern.line}:`;
    case "lineCol":
      return `${pattern.line}:${pattern.col}`;
    case "bof":
      return "bof";
    case "eof":
      return "eof";
    case "range":
      return `${formatPattern(pattern.from)}-${formatPattern(pattern.to)}`;
  }
}

/** An offset into the original (pre-mutation) file content. */
export type InitialDocIndex = number & { __initialDocIndex: true };

/** Records a single mutation in the current-doc coordinate space at the time it occurred. */
export type Transform = {
  start: number;
  beforeEnd: number;
  afterEnd: number;
};

/** Maps an InitialDocIndex through accumulated transforms to a current-doc offset.
 * Throws if the index falls inside a previously replaced region, since the
 * original content there no longer exists and coordinates into it are meaningless. */
export function resolveIndex(
  index: InitialDocIndex,
  transforms: Transform[],
): number {
  let offset: number = index;
  for (const t of transforms) {
    if (offset <= t.start) {
      // Before the mutation, unchanged
    } else if (offset < t.beforeEnd) {
      throw new ExecutionError(
        `Cannot resolve position: original offset ${index} falls inside a previously replaced region [${t.start}, ${t.beforeEnd})`,
      );
    } else {
      // After the mutation, shift by delta
      offset += t.afterEnd - t.beforeEnd;
    }
  }
  return offset;
}

export type FileState = {
  doc: Document;
  path: string;
  mutations: FileMutationSummary;
  isNew?: boolean;
  originalLineStarts: readonly number[];
  originalContentLength: number;
  transforms: Transform[];
};

export class Executor {
  public trace: TraceEntry[] = [];
  public registers = new Map<string, string>();
  public fileDocs = new Map<string, FileState>();
  public currentFile: FileState | undefined;
  public selection: Range[] = [];
  public savedRegisterCount = 0;
  private fileIO: FileIO;

  constructor(fileIO?: FileIO) {
    this.fileIO = fileIO ?? new FsFileIO();
  }

  async getOrLoadFile(path: string): Promise<FileState> {
    let state = this.fileDocs.get(path);
    if (!state) {
      let content: string;
      try {
        content = await this.fileIO.readFile(path);
      } catch (e) {
        throw new ExecutionError(
          `Failed to read file: ${path}: ${e instanceof Error ? e.message : String(e)}`,
          this.trace,
        );
      }
      const doc = new Document(content);
      state = {
        doc,
        path,
        mutations: {
          insertions: 0,
          deletions: 0,
          replacements: 0,
          linesAdded: 0,
          linesRemoved: 0,
        },
        originalLineStarts: doc.lineStarts,
        originalContentLength: content.length,
        transforms: [],
      };
      this.fileDocs.set(path, state);
    }
    return state;
  }

  requireFile(): FileState {
    if (!this.currentFile)
      throw new ExecutionError(
        "No file selected. Use 'file' command first.",
        this.trace,
      );
    return this.currentFile;
  }

  requireSingleSelect(): Range {
    if (this.selection.length !== 1) {
      throw new ExecutionError(
        `Expected single selection, got ${this.selection.length}`,
        this.trace,
      );
    }
    return this.selection[0];
  }

  findAllMatches(
    pattern: Pattern,
    doc: Document,
    withinRanges: Range[],
  ): Range[] {
    const results: Range[] = [];
    for (const scope of withinRanges) {
      const scopeText = doc.getText(scope);
      const matches = this.findInText(pattern, scopeText, doc, scope.start);
      results.push(...matches);
    }
    return results;
  }

  findInText(
    pattern: Pattern,
    text: string,
    doc: Document,
    baseOffset: number,
  ): Range[] {
    switch (pattern.type) {
      case "regex": {
        const results: Range[] = [];
        const flags = pattern.pattern.flags.includes("g")
          ? pattern.pattern.flags
          : pattern.pattern.flags + "g";
        const re = new RegExp(pattern.pattern.source, flags);
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          results.push({
            start: baseOffset + m.index,
            end: baseOffset + m.index + m[0].length,
          });
          if (m[0].length === 0) re.lastIndex++;
        }
        return results;
      }
      case "literal": {
        if (pattern.text.length === 0) {
          throw new ExecutionError(
            `Empty literal pattern will match everywhere. Use a non-empty pattern for select/narrow operations.`,
          );
        }
        const results: Range[] = [];
        let idx = 0;
        while ((idx = text.indexOf(pattern.text, idx)) !== -1) {
          results.push({
            start: baseOffset + idx,
            end: baseOffset + idx + pattern.text.length,
          });
          idx += pattern.text.length;
        }
        return results;
      }
      case "line": {
        const file = this.currentFile;
        if (file) {
          const ols = file.originalLineStarts;
          const idx = pattern.line - 1;
          if (idx < 0 || idx >= ols.length) {
            throw new ExecutionError(
              `Line ${pattern.line} out of range (1-${ols.length})`,
              this.trace,
            );
          }
          const start = resolveIndex(
            ols[idx] as InitialDocIndex,
            file.transforms,
          );
          const origEnd =
            idx + 1 < ols.length
              ? ols[idx + 1] - 1
              : file.originalContentLength;
          const end = resolveIndex(origEnd as InitialDocIndex, file.transforms);
          return [{ start, end }];
        }
        return [doc.lineRange(pattern.line)];
      }
      case "lineCol": {
        const file = this.currentFile;
        if (file) {
          const ols = file.originalLineStarts;
          const idx = pattern.line - 1;
          if (idx < 0 || idx >= ols.length) {
            throw new ExecutionError(
              `Line ${pattern.line} out of range (1-${ols.length})`,
              this.trace,
            );
          }
          const origOffset = ols[idx] + pattern.col;
          const offset = resolveIndex(
            origOffset as InitialDocIndex,
            file.transforms,
          );
          return [{ start: offset, end: offset }];
        }
        const offset = doc.posToOffset({
          line: pattern.line,
          col: pattern.col,
        });
        return [{ start: offset, end: offset }];
      }
      case "bof":
        return [{ start: 0, end: 0 }];
      case "eof":
        return [{ start: doc.content.length, end: doc.content.length }];
      case "range": {
        const fromMatches = this.findInText(
          pattern.from,
          text,
          doc,
          baseOffset,
        );
        const toMatches = this.findInText(pattern.to, text, doc, baseOffset);
        if (fromMatches.length === 0 || toMatches.length === 0) return [];
        return [{ start: fromMatches[0].start, end: toMatches[0].end }];
      }
    }
  }

  addTrace(command: string, ranges: Range[], doc: Document): void {
    const texts = ranges.map((r) => doc.getText(r));
    const snippet =
      texts.length === 1
        ? Executor.formatSnippet(texts[0])
        : texts.map((t) => Executor.formatSnippet(t)).join(" | ");
    this.trace.push({ command, ranges: [...ranges], snippet });
  }

  static formatSnippet(text: string): string {
    const lines = text.split("\n");
    if (lines.length === 1) {
      const line = lines[0];
      if (line.length > MAX_SNIPPET_LENGTH) {
        const half = Math.floor((MAX_SNIPPET_LENGTH - 3) / 2);
        return line.slice(0, half) + "..." + line.slice(line.length - half);
      }
      return line;
    }
    const first = lines[0];
    const last = lines[lines.length - 1];
    return first + "\n...\n" + last;
  }

  static countLines(text: string): number {
    if (text.length === 0) return 0;
    let count = 1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") count++;
    }
    return count;
  }

  static recalcSelectionAfterReplace(
    originalRanges: Range[],
    replacementText: string,
  ): Range[] {
    const sorted = [...originalRanges].sort((a, b) => a.start - b.start);
    const result: Range[] = [];
    let offsetShift = 0;
    for (const range of sorted) {
      const newStart = range.start + offsetShift;
      const newEnd = newStart + replacementText.length;
      result.push({ start: newStart, end: newEnd });
      const oldLen = range.end - range.start;
      offsetShift += replacementText.length - oldLen;
    }
    return result;
  }

  private recordTransform(
    file: FileState,
    start: number,
    beforeEnd: number,
    afterEnd: number,
  ): void {
    file.transforms.push({ start, beforeEnd, afterEnd });
  }
  private findNextFileCommand(
    commands: Command[],
    startIndex: number,
    excludePath: string,
  ): number {
    for (let i = startIndex; i < commands.length; i++) {
      const cmd = commands[i];
      if (
        (cmd.type === "file" || cmd.type === "newfile") &&
        cmd.path !== excludePath
      ) {
        return i;
      }
    }
    return -1;
  }

  private resolveText(cmd: MutationText): string {
    if ("text" in cmd) return cmd.text;
    const text = this.registers.get(cmd.register);
    if (text === undefined)
      throw new ExecutionError(
        `Register "${cmd.register}" is empty or does not exist`,
        this.trace,
      );
    return text;
  }
  private async executeCommand(cmd: Command): Promise<void> {
    switch (cmd.type) {
      case "file": {
        this.currentFile = await this.getOrLoadFile(cmd.path);
        this.selection = [this.currentFile.doc.fullRange()];
        this.trace.push({
          command: `file ${cmd.path}`,
          ranges: [...this.selection],
          snippet: `switched to ${cmd.path} (${this.currentFile.doc.lineCount} lines)`,
        });
        break;
      }
      case "newfile": {
        if (this.fileDocs.has(cmd.path)) {
          throw new ExecutionError(
            `newfile: file already loaded: ${cmd.path}`,
            this.trace,
          );
        }
        const exists = await this.fileIO.fileExists(cmd.path);
        if (exists) {
          throw new ExecutionError(
            `newfile: file already exists on disk: ${cmd.path}`,
            this.trace,
          );
        }
        const newDoc = new Document("");
        const state: FileState = {
          doc: newDoc,
          path: cmd.path,
          mutations: {
            insertions: 0,
            deletions: 0,
            replacements: 0,
            linesAdded: 0,
            linesRemoved: 0,
          },
          isNew: true,
          originalLineStarts: newDoc.lineStarts,
          originalContentLength: 0,
          transforms: [],
        };
        this.fileDocs.set(cmd.path, state);
        this.currentFile = state;
        this.selection = [{ start: 0, end: 0 }];
        this.trace.push({
          command: `newfile ${cmd.path}`,
          ranges: [...this.selection],
          snippet: `created ${cmd.path}`,
        });
        break;
      }

      case "narrow": {
        const file = this.requireFile();
        const matches = this.findAllMatches(
          cmd.pattern,
          file.doc,
          this.selection,
        );
        if (matches.length === 0)
          throw new ExecutionError(
            `narrow: no matches for pattern ${formatPattern(cmd.pattern)}`,
            this.trace,
          );
        this.selection = matches;
        this.addTrace("narrow", this.selection, file.doc);
        break;
      }
      case "select": {
        const file = this.requireFile();
        const matches = this.findInText(
          cmd.pattern,
          file.doc.content,
          file.doc,
          0,
        );
        if (matches.length === 0)
          throw new ExecutionError(
            `select: no matches for pattern ${formatPattern(cmd.pattern)}`,
            this.trace,
          );
        this.selection = matches;
        this.addTrace("select", this.selection, file.doc);
        break;
      }

      case "select_one": {
        const file = this.requireFile();
        const matches = this.findInText(
          cmd.pattern,
          file.doc.content,
          file.doc,
          0,
        );
        if (matches.length === 0)
          throw new ExecutionError(
            `select_one: no matches for pattern ${formatPattern(cmd.pattern)}`,
            this.trace,
          );
        if (matches.length > 1)
          throw new ExecutionError(
            `select_one: expected 1 match, got ${matches.length}`,
            this.trace,
          );
        this.selection = [matches[0]];
        this.addTrace("select_one", this.selection, file.doc);
        break;
      }

      case "retain_first": {
        if (this.selection.length === 0)
          throw new ExecutionError("retain_first: no selections", this.trace);
        this.selection = [this.selection[0]];
        const file = this.requireFile();
        this.addTrace("retain_first", this.selection, file.doc);
        break;
      }

      case "retain_last": {
        if (this.selection.length === 0)
          throw new ExecutionError("retain_last: no selections", this.trace);
        this.selection = [this.selection[this.selection.length - 1]];
        const file = this.requireFile();
        this.addTrace("retain_last", this.selection, file.doc);
        break;
      }

      case "narrow_one": {
        const file = this.requireFile();
        const matches = this.findAllMatches(
          cmd.pattern,
          file.doc,
          this.selection,
        );
        if (matches.length === 0)
          throw new ExecutionError(
            `narrow_one: no matches for pattern ${formatPattern(cmd.pattern)}`,
            this.trace,
          );
        if (matches.length > 1)
          throw new ExecutionError(
            `narrow_one: expected 1 match, got ${matches.length}`,
            this.trace,
          );
        this.selection = [matches[0]];
        this.addTrace("narrow_one", this.selection, file.doc);
        break;
      }

      case "select_next": {
        const file = this.requireFile();
        const current = this.requireSingleSelect();
        const searchText = file.doc.content.slice(current.end);
        const matches = this.findInText(
          cmd.pattern,
          searchText,
          file.doc,
          current.end,
        );
        if (matches.length === 0)
          throw new ExecutionError(
            `select_next: no matches after selection for pattern ${formatPattern(cmd.pattern)}`,
            this.trace,
          );
        this.selection = [matches[0]];
        this.addTrace("select_next", this.selection, file.doc);
        break;
      }

      case "select_prev": {
        const file = this.requireFile();
        const current = this.requireSingleSelect();
        const searchText = file.doc.content.slice(0, current.start);
        const matches = this.findInText(cmd.pattern, searchText, file.doc, 0);
        if (matches.length === 0)
          throw new ExecutionError(
            `select_prev: no matches before selection for pattern ${formatPattern(cmd.pattern)}`,
            this.trace,
          );
        this.selection = [matches[matches.length - 1]];
        this.addTrace("select_prev", this.selection, file.doc);
        break;
      }

      case "extend_forward": {
        const file = this.requireFile();
        const current = this.requireSingleSelect();
        const searchText = file.doc.content.slice(current.end);
        const matches = this.findInText(
          cmd.pattern,
          searchText,
          file.doc,
          current.end,
        );
        if (matches.length === 0)
          throw new ExecutionError(
            `extend_forward: no matches after selection for pattern ${formatPattern(cmd.pattern)}`,
            this.trace,
          );
        this.selection = [{ start: current.start, end: matches[0].end }];
        this.addTrace("extend_forward", this.selection, file.doc);
        break;
      }

      case "extend_back": {
        const file = this.requireFile();
        const current = this.requireSingleSelect();
        const searchText = file.doc.content.slice(0, current.start);
        const matches = this.findInText(cmd.pattern, searchText, file.doc, 0);
        if (matches.length === 0)
          throw new ExecutionError(
            `extend_back: no matches before selection for pattern ${formatPattern(cmd.pattern)}`,
            this.trace,
          );
        this.selection = [
          {
            start: matches[matches.length - 1].start,
            end: current.end,
          },
        ];
        this.addTrace("extend_back", this.selection, file.doc);
        break;
      }

      case "retain_nth": {
        if (this.selection.length === 0)
          throw new ExecutionError("retain_nth: no selections", this.trace);
        const n = cmd.n < 0 ? this.selection.length + cmd.n : cmd.n;
        if (n < 0 || n >= this.selection.length)
          throw new ExecutionError(
            `retain_nth: index ${cmd.n} out of range (${this.selection.length} selections)`,
            this.trace,
          );
        this.selection = [this.selection[n]];
        const file = this.requireFile();
        this.addTrace(`retain_nth ${cmd.n}`, this.selection, file.doc);
        break;
      }

      case "replace": {
        const file = this.requireFile();
        if (this.selection.length === 0)
          throw new ExecutionError("replace: no selection", this.trace);
        const text = this.resolveText(cmd);
        const sorted = [...this.selection].sort((a, b) => b.start - a.start);
        for (const range of sorted) {
          const oldText = file.doc.getText(range);
          this.recordTransform(
            file,
            range.start,
            range.end,
            range.start + text.length,
          );
          file.doc.splice(range, text);
          file.mutations.replacements++;
          file.mutations.linesRemoved += Executor.countLines(oldText);
          file.mutations.linesAdded += Executor.countLines(text);
        }
        this.selection = Executor.recalcSelectionAfterReplace(
          this.selection,
          text,
        );
        this.addTrace("replace", this.selection, file.doc);
        break;
      }

      case "delete": {
        const file = this.requireFile();
        if (this.selection.length === 0)
          throw new ExecutionError("delete: no selection", this.trace);
        this.addTrace("delete", this.selection, file.doc);
        const sorted = [...this.selection].sort((a, b) => b.start - a.start);
        for (const range of sorted) {
          const oldText = file.doc.getText(range);
          this.recordTransform(file, range.start, range.end, range.start);
          file.doc.splice(range, "");
          file.mutations.deletions++;
          file.mutations.linesRemoved += Executor.countLines(oldText);
        }
        const firstRange = this.selection[0];
        this.selection = [{ start: firstRange.start, end: firstRange.start }];
        break;
      }

      case "insert_before": {
        const file = this.requireFile();
        if (this.selection.length === 0)
          throw new ExecutionError("insert_before: no selection", this.trace);
        const text = this.resolveText(cmd);
        const sorted = [...this.selection].sort((a, b) => b.start - a.start);
        for (const range of sorted) {
          this.recordTransform(
            file,
            range.start,
            range.start,
            range.start + text.length,
          );
          file.doc.splice({ start: range.start, end: range.start }, text);
          file.mutations.insertions++;
          file.mutations.linesAdded += Executor.countLines(text);
        }
        this.addTrace("insert_before", this.selection, file.doc);
        break;
      }

      case "insert_after": {
        const file = this.requireFile();
        if (this.selection.length === 0)
          throw new ExecutionError("insert_after: no selection", this.trace);
        const text = this.resolveText(cmd);
        const sorted = [...this.selection].sort((a, b) => b.start - a.start);
        for (const range of sorted) {
          this.recordTransform(
            file,
            range.end,
            range.end,
            range.end + text.length,
          );
          file.doc.splice({ start: range.end, end: range.end }, text);
          file.mutations.insertions++;
          file.mutations.linesAdded += Executor.countLines(text);
        }
        this.addTrace("insert_after", this.selection, file.doc);
        break;
      }

      case "cut": {
        const file = this.requireFile();
        const range = this.requireSingleSelect();
        const text = file.doc.getText(range);
        this.registers.set(cmd.register, text);
        this.recordTransform(file, range.start, range.end, range.start);
        file.doc.splice(range, "");
        file.mutations.deletions++;
        file.mutations.linesRemoved += Executor.countLines(text);
        this.addTrace(`cut ${cmd.register}`, [range], file.doc);
        this.selection = [{ start: range.start, end: range.start }];
        break;
      }
    }
  }

  private static getCommandText(cmd: Command): string | undefined {
    if (
      cmd.type === "replace" ||
      cmd.type === "insert_before" ||
      cmd.type === "insert_after"
    ) {
      return "text" in cmd ? cmd.text : undefined;
    }
    return undefined;
  }

  private saveCommandTexts(
    commands: Command[],
    startIdx: number,
    endIdx: number,
  ): SavedRegisterInfo[] {
    const saved: SavedRegisterInfo[] = [];
    for (let j = startIdx; j < endIdx; j++) {
      const text = Executor.getCommandText(commands[j]);
      if (text !== undefined) {
        const name = `_saved_${++this.savedRegisterCount}`;
        this.registers.set(name, text);
        saved.push({ name, sizeChars: text.length });
      }
    }
    return saved;
  }
  async execute(commands: Command[]): Promise<ScriptResult> {
    const fileErrors: FileError[] = [];
    const failedFiles = new Set<string>();
    let i = 0;

    while (i < commands.length) {
      const cmd = commands[i];

      try {
        await this.executeCommand(cmd);
        i++;
      } catch (e) {
        if (e instanceof ExecutionError) {
          const errorPath =
            cmd.type === "file" || cmd.type === "newfile"
              ? cmd.path
              : this.currentFile?.path;

          if (errorPath) {
            failedFiles.add(errorPath);

            const nextIdx = this.findNextFileCommand(
              commands,
              i + 1,
              errorPath,
            );
            const skipEnd = nextIdx === -1 ? commands.length : nextIdx;

            const savedRegisters = this.saveCommandTexts(commands, i, skipEnd);

            fileErrors.push({
              path: errorPath,
              error: e.message,
              trace: [...e.trace],
              savedRegisters,
            });

            if (nextIdx === -1) {
              break;
            }
            i = nextIdx;
            this.currentFile = undefined;
            this.selection = [];
          } else {
            throw e;
          }
        } else {
          throw e;
        }
      }
    }

    const mutations = new Map<string, FileMutationSummary>();
    const fileContents = new Map<string, string>();
    const newFiles = new Set<string>();
    for (const [path, state] of this.fileDocs) {
      if (failedFiles.has(path)) continue;

      const m = state.mutations;
      if (m.insertions > 0 || m.deletions > 0 || m.replacements > 0) {
        mutations.set(path, m);
        fileContents.set(path, state.doc.content);
      }
      if (state.isNew) {
        newFiles.add(path);
        fileContents.set(path, state.doc.content);
      }
    }

    for (const path of new Set([...mutations.keys(), ...newFiles])) {
      const state = this.fileDocs.get(path)!;
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir) {
        await this.fileIO.mkdir(dir);
      }
      await this.fileIO.writeFile(path, state.doc.content);
    }

    let finalSelection: { ranges: RangeWithPos[] } | undefined;
    if (this.selection.length > 0 && this.currentFile) {
      const doc = this.currentFile.doc;
      finalSelection = {
        ranges: this.selection.map((r) => ({
          range: r,
          startPos: doc.offsetToPos(r.start),
          endPos: doc.offsetToPos(r.end),
          content: doc.getText(r),
        })),
      };
    }

    return {
      trace: this.trace,
      finalSelection,
      mutations,
      fileContents,
      fileErrors,
    };
  }
}
