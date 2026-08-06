export type PositionalPattern =
  | { type: "line"; line: number }
  | { type: "lineCol"; line: number; col: number }
  | { type: "bof" }
  | { type: "eof" };

export type Pattern =
  | { type: "regex"; pattern: RegExp }
  | { type: "literal"; text: string }
  | PositionalPattern
  | { type: "range"; from: PositionalPattern; to: PositionalPattern };

export type Command =
  | { type: "file"; path: string }
  | { type: "newfile"; path: string }
  | { type: "narrow"; pattern: Pattern }
  | { type: "narrow_multiple"; pattern: Pattern }
  | { type: "retain_first" }
  | { type: "retain_last" }
  | { type: "retain_nth"; n: number }
  | { type: "select_next"; pattern: Pattern }
  | { type: "select_prev"; pattern: Pattern }
  | { type: "extend_forward"; pattern: Pattern }
  | { type: "extend_back"; pattern: Pattern }
  | ({ type: "replace" } & MutationText)
  | { type: "delete" }
  | ({ type: "insert_before" } & MutationText)
  | ({ type: "insert_after" } & MutationText)
  | { type: "select"; pattern: Pattern }
  | { type: "select_multiple"; pattern: Pattern }
  | { type: "cut"; register: string };

export type MutationText =
  | { text: string; isHeredoc: boolean }
  | { register: string };

export class ParseError extends Error {}

export function formatPatternSource(pattern: Pattern): string {
  switch (pattern.type) {
    case "regex":
      return `/${pattern.pattern.source}/${pattern.pattern.flags.replace("g", "")}`;
    case "literal":
      return `<<EDL\n${pattern.text}\nEDL`;
    case "line":
      return `${pattern.line}:`;
    case "lineCol":
      return `${pattern.line}:${pattern.col}`;
    case "bof":
      return "bof";
    case "eof":
      return "eof";
    case "range":
      return `${formatPatternSource(pattern.from)}-${formatPatternSource(pattern.to)}`;
  }
}

function formatMutationTextSource(text: MutationText): string {
  if ("register" in text) return text.register;
  return text.isHeredoc
    ? `<<EDL\n${text.text}\nEDL`
    : JSON.stringify(text.text);
}

/** Reconstructs the source text of a parsed command, for error display. */
export function formatCommandSource(cmd: Command): string {
  switch (cmd.type) {
    case "file":
    case "newfile":
      return `${cmd.type} \`${cmd.path}\``;
    case "retain_first":
    case "retain_last":
    case "delete":
      return cmd.type;
    case "retain_nth":
      return `retain_nth ${cmd.n}`;
    case "cut":
      return `cut ${cmd.register}`;
    case "replace":
    case "insert_before":
    case "insert_after":
      return `${cmd.type} ${formatMutationTextSource(cmd)}`;
    default:
      return `${cmd.type} ${formatPatternSource(cmd.pattern)}`;
  }
}

export type Token =
  | { type: "word"; value: string }
  | { type: "regex"; pattern: string; flags: string }
  | { type: "path"; value: string }
  | { type: "heredoc"; value: string }
  | { type: "quoted"; value: string };

const FLAG_CHARS = new Set("gimsuy");

/**
 * Stateful tokenizer over the strict EDL grammar. Exposes `next()` for the
 * normal token stream and `nextPath()` for path-expecting positions (after
 * `file`/`newfile`), where a bare word may legitimately start with `/` (e.g.
 * absolute paths like `/tmp/foo.md`) and must not be mis-lexed as a regex.
 */
export class Tokenizer {
  private pos = 0;
  constructor(private readonly script: string) {}

  private skipTrivia(): void {
    const { script } = this;
    while (this.pos < script.length) {
      while (this.pos < script.length && /\s/.test(script[this.pos]))
        this.pos++;
      if (this.pos < script.length && script[this.pos] === "#") {
        while (this.pos < script.length && script[this.pos] !== "\n")
          this.pos++;
        continue;
      }
      break;
    }
  }

  /**
   * Read a path token. A backtick-delimited path literal is read verbatim;
   * otherwise a whitespace-delimited bare word is returned, so leading slashes
   * and interior slashes are treated as ordinary path characters.
   */
  nextPath(): string | undefined {
    this.skipTrivia();
    const { script } = this;
    if (this.pos >= script.length) return undefined;
    if (script[this.pos] === "`") {
      this.pos++;
      const start = this.pos;
      while (this.pos < script.length && script[this.pos] !== "`") this.pos++;
      if (this.pos >= script.length) {
        throw new ParseError(`Unterminated path literal`);
      }
      const value = script.slice(start, this.pos);
      this.pos++;
      return value;
    }
    const start = this.pos;
    while (this.pos < script.length && !/\s/.test(script[this.pos])) this.pos++;
    return script.slice(start, this.pos);
  }

  next(): Token | undefined {
    const tok = readToken(this.script, this.pos);
    if (!tok) return undefined;
    this.pos = tok.nextPos;
    return tok.token;
  }
}

/**
 * Read a single strict token starting at `startPos`, skipping leading
 * whitespace and comments. Returns the token together with the position after
 * it, or `undefined` at end of input. Throws `ParseError` on malformed tokens.
 */
function readToken(
  script: string,
  startPos: number,
): { token: Token; nextPos: number } | undefined {
  let pos = startPos;

  while (pos < script.length) {
    // skip whitespace and newlines
    while (pos < script.length && /\s/.test(script[pos])) pos++;
    if (pos >= script.length) return undefined;

    const ch = script[pos];
    // comment — skip to end of line
    if (ch === "#") {
      while (pos < script.length && script[pos] !== "\n") pos++;
      continue;
    }

    // regex: /pattern/flags
    if (ch === "/") {
      pos++; // skip opening /
      const patStart = pos;
      while (pos < script.length) {
        const c = script[pos];
        if (c === "\n") break;
        if (c === "\\") {
          pos += 2;
          continue;
        }
        if (c === "/") break;
        pos++;
      }
      if (pos >= script.length || script[pos] !== "/") {
        throw new ParseError(`Unterminated regex`);
      }
      const pattern = script.slice(patStart, pos);
      pos++; // skip closing /
      const flagStart = pos;
      while (pos < script.length && FLAG_CHARS.has(script[pos])) pos++;
      return {
        token: { type: "regex", pattern, flags: script.slice(flagStart, pos) },
        nextPos: pos,
      };
    }

    // path: `filepath`
    if (ch === "`") {
      pos++; // skip opening `
      const pathStart = pos;
      while (pos < script.length && script[pos] !== "`") pos++;
      if (pos >= script.length) {
        throw new ParseError(`Unterminated path literal`);
      }
      const value = script.slice(pathStart, pos);
      pos++; // skip closing `
      return { token: { type: "path", value }, nextPos: pos };
    }

    // heredoc: <<DELIM
    if (ch === "<" && script[pos + 1] === "<") {
      pos += 2; // skip <<
      let delimiter: string;
      if (script[pos] === "'") {
        pos++; // skip opening quote
        const delimStart = pos;
        while (
          pos < script.length &&
          script[pos] !== "'" &&
          script[pos] !== "\n"
        )
          pos++;
        if (pos >= script.length || script[pos] !== "'") {
          throw new ParseError(`Unterminated quoted heredoc marker`);
        }
        delimiter = script.slice(delimStart, pos);
        pos++; // skip closing quote
        if (delimiter.length === 0) {
          throw new ParseError(`Invalid heredoc marker`);
        }
      } else {
        const delimStart = pos;
        while (pos < script.length && /\w/.test(script[pos])) pos++;
        if (pos === delimStart) {
          throw new ParseError(`Invalid heredoc marker`);
        }
        delimiter = script.slice(delimStart, pos);
      }
      // skip to next line
      while (pos < script.length && script[pos] !== "\n") {
        if (!/\s/.test(script[pos])) {
          throw new ParseError(`Unexpected content after heredoc marker`);
        }
        pos++;
      }
      if (pos < script.length) pos++; // skip the \n

      // find the delimiter on its own line
      const contentStart = pos;
      while (pos < script.length) {
        const lineStart = pos;
        while (pos < script.length && script[pos] !== "\n") pos++;
        if (script.slice(lineStart, pos) === delimiter) {
          const value = script.slice(
            contentStart,
            lineStart > contentStart ? lineStart - 1 : lineStart,
          );
          if (pos < script.length) pos++; // skip \n after delimiter
          return { token: { type: "heredoc", value }, nextPos: pos };
        }
        if (pos < script.length) pos++; // skip \n
      }
      throw new ParseError(`Unterminated heredoc, expected ${delimiter}`);
    }

    // quoted string: "text"
    if (ch === '"') {
      pos++; // skip opening "
      let value = "";
      while (pos < script.length && script[pos] !== '"') {
        if (script[pos] === "\\") {
          pos++;
          if (pos >= script.length) {
            throw new ParseError("Unterminated quoted string");
          }
          const escaped = script[pos];
          if (escaped === '"' || escaped === "\\") {
            value += escaped;
          } else {
            throw new ParseError(
              `Invalid escape sequence in quoted string: \\${escaped}`,
            );
          }
        } else if (script[pos] === "\n") {
          throw new ParseError(
            "Unterminated quoted string (newline before closing quote)",
          );
        } else {
          value += script[pos];
        }
        pos++;
      }
      if (pos >= script.length) {
        throw new ParseError("Unterminated quoted string");
      }
      pos++; // skip closing "
      return { token: { type: "quoted", value }, nextPos: pos };
    }
    // word: consume until whitespace
    const start = pos;
    while (pos < script.length && !/\s/.test(script[pos])) pos++;
    return {
      token: { type: "word", value: script.slice(start, pos) },
      nextPos: pos,
    };
  }

  return undefined;
}

export function* lex(script: string): Generator<Token> {
  const tokenizer = new Tokenizer(script);
  let tok: Token | undefined;
  while ((tok = tokenizer.next()) !== undefined) {
    yield tok;
  }
}

export type PositionedToken = { token: Token; start: number };

/**
 * Tolerant variant of `lex` that yields each token together with its start
 * offset in the script, and stops gracefully (returns) instead of throwing on
 * truncated/incomplete input. Display-only; never used by the executor.
 */
export function* lexWithPos(script: string): Generator<PositionedToken> {
  let pos = 0;

  while (pos < script.length) {
    while (pos < script.length && /\s/.test(script[pos])) pos++;
    if (pos >= script.length) break;

    const start = pos;
    const ch = script[pos];

    if (ch === "#") {
      while (pos < script.length && script[pos] !== "\n") pos++;
      continue;
    }

    if (ch === "/") {
      pos++;
      const patStart = pos;
      while (pos < script.length) {
        const c = script[pos];
        if (c === "\n") break;
        if (c === "\\") {
          pos += 2;
          continue;
        }
        if (c === "/") break;
        pos++;
      }
      if (pos >= script.length || script[pos] !== "/") return;
      const pattern = script.slice(patStart, pos);
      pos++;
      const flagStart = pos;
      while (pos < script.length && FLAG_CHARS.has(script[pos])) pos++;
      yield {
        token: { type: "regex", pattern, flags: script.slice(flagStart, pos) },
        start,
      };
      continue;
    }

    if (ch === "`") {
      pos++;
      const pathStart = pos;
      while (pos < script.length && script[pos] !== "`") pos++;
      if (pos >= script.length) return;
      yield {
        token: { type: "path", value: script.slice(pathStart, pos) },
        start,
      };
      pos++;
      continue;
    }

    if (ch === "<" && script[pos + 1] === "<") {
      pos += 2;
      let delimiter: string;
      if (script[pos] === "'") {
        pos++;
        const delimStart = pos;
        while (
          pos < script.length &&
          script[pos] !== "'" &&
          script[pos] !== "\n"
        )
          pos++;
        if (pos >= script.length || script[pos] !== "'") return;
        delimiter = script.slice(delimStart, pos);
        pos++;
        if (delimiter.length === 0) return;
      } else {
        const delimStart = pos;
        while (pos < script.length && /\w/.test(script[pos])) pos++;
        if (pos === delimStart) return;
        delimiter = script.slice(delimStart, pos);
      }
      while (pos < script.length && script[pos] !== "\n") {
        if (!/\s/.test(script[pos])) return;
        pos++;
      }
      if (pos < script.length) pos++;

      const contentStart = pos;
      let found = false;
      while (pos < script.length) {
        const lineStart = pos;
        while (pos < script.length && script[pos] !== "\n") pos++;
        if (script.slice(lineStart, pos) === delimiter) {
          const value = script.slice(
            contentStart,
            lineStart > contentStart ? lineStart - 1 : lineStart,
          );
          if (pos < script.length) pos++;
          yield { token: { type: "heredoc", value }, start };
          found = true;
          break;
        }
        if (pos < script.length) pos++;
      }
      if (!found) return;
      continue;
    }

    if (ch === '"') {
      pos++;
      let value = "";
      while (pos < script.length && script[pos] !== '"') {
        if (script[pos] === "\\") {
          pos++;
          if (pos >= script.length) return;
          const escaped = script[pos];
          if (escaped === '"' || escaped === "\\") {
            value += escaped;
          } else {
            return;
          }
        } else if (script[pos] === "\n") {
          return;
        } else {
          value += script[pos];
        }
        pos++;
      }
      if (pos >= script.length) return;
      pos++;
      yield { token: { type: "quoted", value }, start };
      continue;
    }

    const wordStart = pos;
    while (pos < script.length && !/\s/.test(script[pos])) pos++;
    yield {
      token: { type: "word", value: script.slice(wordStart, pos) },
      start,
    };
  }
}

function tryParsePositionalPattern(s: string): PositionalPattern | undefined {
  if (s === "bof") return { type: "bof" };
  if (s === "eof") return { type: "eof" };
  const lineColMatch = s.match(/^(\d+):(\d+)$/);
  if (lineColMatch) {
    return {
      type: "lineCol",
      line: parseInt(lineColMatch[1], 10),
      col: parseInt(lineColMatch[2], 10),
    };
  }
  const lineMatch = s.match(/^(\d+):?$/);
  if (lineMatch) {
    return { type: "line", line: parseInt(lineMatch[1], 10) };
  }
  return undefined;
}

function assertNotPositionalArg(command: string, word: string): void {
  const pos = tryParsePositionalPattern(word);
  const isRange =
    word.includes("-") &&
    word.split("-").every((part) => {
      return tryParsePositionalPattern(part) !== undefined;
    });
  if (pos || isRange) {
    throw new ParseError(
      `\`${command}\` does not take a positional argument like \`${word}\` — it operates on the current selection. Position the selection first (e.g. \`select bof\` or \`select eof\`), then call \`${command}\` with a heredoc, quoted string, or register name.`,
    );
  }
}

function tokenToPattern(tok: Token): Pattern {
  switch (tok.type) {
    case "regex": {
      const flags = tok.flags.includes("g") ? tok.flags : `${tok.flags}g`;
      return { type: "regex", pattern: new RegExp(tok.pattern, flags) };
    }
    case "heredoc":
      return { type: "literal", text: tok.value };
    case "word": {
      const dashIdx = tok.value.indexOf("-");
      if (dashIdx > 0 && dashIdx < tok.value.length - 1) {
        const fromStr = tok.value.slice(0, dashIdx);
        const toStr = tok.value.slice(dashIdx + 1);
        const from = tryParsePositionalPattern(fromStr);
        const to = tryParsePositionalPattern(toStr);
        if (from && to) {
          return { type: "range", from, to };
        }
      }

      const pos = tryParsePositionalPattern(tok.value);
      if (pos) return pos;

      throw new ParseError(`Invalid pattern: ${tok.value}`);
    }
    case "path":
      throw new ParseError(`Unexpected path literal in pattern position`);
    case "quoted":
      throw new ParseError(
        `Unexpected quoted string in pattern position. Use a heredoc for line selection or regex for inline selection.`,
      );
  }
}

function findConflictingHeredocDelimiters(script: string): string[] {
  const heredocPattern = /<<'?(\w+)'?/g;
  const delimiters = new Set<string>();
  let match;
  while ((match = heredocPattern.exec(script)) !== null) {
    delimiters.add(match[1]);
  }

  const lines = script.split("\n");
  const conflicts: string[] = [];
  for (const delim of delimiters) {
    let count = 0;
    for (const line of lines) {
      if (line === delim) count++;
    }
    if (count > 1) {
      conflicts.push(delim);
    }
  }
  return conflicts;
}
export function parse(script: string): Command[] {
  try {
    const tokenizer = new Tokenizer(script);
    const commands: Command[] = [];

    function next(expected?: string): Token | undefined {
      const tok = tokenizer.next();
      if (tok === undefined) {
        if (expected) {
          throw new ParseError(`Expected ${expected}, got end of input`);
        }
        return undefined;
      }
      return tok;
    }

    function nextPath(): string {
      const path = tokenizer.nextPath();
      if (path === undefined || path.length === 0) {
        throw new ParseError(`Expected file path, got end of input`);
      }
      return path;
    }

    function expectWord(expected: string): Token & { type: "word" } {
      const tok = next(expected)!;
      if (tok.type !== "word") {
        throw new ParseError(`Expected ${expected}, got ${tok.type}`);
      }
      return tok as Token & { type: "word" };
    }

    let cmdTok: Token | undefined;
    while ((cmdTok = next()) !== undefined) {
      if (cmdTok.type !== "word") {
        throw new ParseError(`Expected command, got ${cmdTok.type}`);
      }

      switch (cmdTok.value) {
        case "file": {
          commands.push({ type: "file", path: nextPath() });
          break;
        }
        case "newfile": {
          commands.push({ type: "newfile", path: nextPath() });
          break;
        }

        case "narrow":
        case "narrow_multiple":
        case "select":
        case "select_multiple":
        case "select_next":
        case "select_prev":
        case "extend_forward":
        case "extend_back": {
          const tok = next("pattern")!;
          commands.push({ type: cmdTok.value, pattern: tokenToPattern(tok) });
          break;
        }

        case "retain_nth": {
          const nTok = expectWord("number");
          commands.push({ type: "retain_nth", n: parseInt(nTok.value, 10) });
          break;
        }

        case "replace": {
          const tok = next("heredoc, quoted string, or register name")!;
          if (tok.type === "heredoc") {
            commands.push({
              type: "replace",
              text: tok.value,
              isHeredoc: true,
            });
          } else if (tok.type === "quoted") {
            commands.push({
              type: "replace",
              text: tok.value,
              isHeredoc: false,
            });
          } else if (tok.type === "word") {
            assertNotPositionalArg("replace", tok.value);
            commands.push({ type: "replace", register: tok.value });
          } else {
            throw new ParseError(
              `Expected heredoc, quoted string, or register name after replace, got ${tok.type}`,
            );
          }
          break;
        }

        case "retain_first":
        case "retain_last":
        case "delete": {
          commands.push({ type: cmdTok.value });
          break;
        }

        case "insert_before":
        case "insert_after": {
          const tok = next("heredoc, quoted string, or register name")!;
          if (tok.type === "heredoc") {
            commands.push({
              type: cmdTok.value,
              text: tok.value,
              isHeredoc: true,
            } as Command);
          } else if (tok.type === "quoted") {
            commands.push({
              type: cmdTok.value,
              text: tok.value,
              isHeredoc: false,
            } as Command);
          } else if (tok.type === "word") {
            assertNotPositionalArg(cmdTok.value, tok.value);
            commands.push({
              type: cmdTok.value,
              register: tok.value,
            } as Command);
          } else {
            throw new ParseError(
              `Expected heredoc, quoted string, or register name after ${cmdTok.value}, got ${tok.type}`,
            );
          }
          break;
        }

        case "cut": {
          const regTok = expectWord("register name");
          commands.push({ type: "cut", register: regTok.value });
          break;
        }

        default:
          throw new ParseError(`Unknown command: ${cmdTok.value}`);
      }
    }

    return commands;
  } catch (e) {
    if (e instanceof ParseError) {
      const conflicts = findConflictingHeredocDelimiters(script);
      if (conflicts.length > 0) {
        throw new ParseError(
          `${e.message}\nNote: heredoc delimiter${conflicts.length > 1 ? "s" : ""} ${conflicts.map((d) => `"${d}"`).join(", ")} appeared multiple times as standalone line${conflicts.length > 1 ? "s" : ""} in the script. This likely means the delimiter conflicts with the heredoc content. Use a unique termination code that does not appear in the content (e.g. <<UNIQUE_MARKER instead of <<${conflicts[0]}).`,
        );
      }
    }
    throw e;
  }
}
