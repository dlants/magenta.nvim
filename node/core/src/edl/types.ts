/** 1-indexed line, 0-indexed column */
export type Pos = { line: number; col: number };

/** Character offset range, end-exclusive */
export type Range = { start: number; end: number; isLineSelection?: boolean };

export type TraceEntry = {
  command: string;
  ranges: Range[];
  snippet: string;
};

export type FileMutationSummary = {
  insertions: number;
  deletions: number;
  replacements: number;
  linesAdded: number;
  linesRemoved: number;
};

export type RangeWithPos = {
  range: Range;
  startPos: Pos;
  endPos: Pos;
  content: string;
};

export type SavedRegisterInfo = {
  name: string;
  sizeChars: number;
};

export type FileError = {
  path: string;
  error: string;
  failedMutations: number;
  /** Source text of the command that failed, followed by the commands skipped as a result. */
  failedCommands: string[];
  trace: TraceEntry[];
  savedRegisters: SavedRegisterInfo[];
};

export type ScriptResult = {
  warnings: string[];
  trace: TraceEntry[];
  finalSelection: { ranges: RangeWithPos[] } | undefined;
  mutations: Map<string, FileMutationSummary>;
  fileContents: Map<string, { content: string; previousContent: string }>;
  fileErrors: FileError[];
};
