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
  | { type: "narrow_one"; pattern: Pattern }
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
  | { type: "select_one"; pattern: Pattern }
  | { type: "cut"; register: string };

export type MutationText = { text: string } | { register: string };

export class ParseError extends Error {}

export type Token =
  | { type: "word"; value: string }
  | { type: "regex"; pattern: string; flags: string }
  | { type: "path"; value: string }
  | { type: "heredoc"; value: string };

const FLAG_CHARS = new Set("gimsuy");

export function* lex(script: string): Generator<Token> {
  let pos = 0;

  while (pos < script.length) {
    // skip whitespace and newlines
    while (pos < script.length && /\s/.test(script[pos])) pos++;
    if (pos >= script.length) break;

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
      yield { type: "regex", pattern, flags: script.slice(flagStart, pos) };
      continue;
    }

    // path: `filepath`
    if (ch === "`") {
      pos++; // skip opening `
      const pathStart = pos;
      while (pos < script.length && script[pos] !== "`") pos++;
      if (pos >= script.length) {
        throw new ParseError(`Unterminated path literal`);
      }
      yield { type: "path", value: script.slice(pathStart, pos) };
      pos++; // skip closing `
      continue;
    }

    // heredoc: <<DELIM
    if (ch === "<" && script[pos + 1] === "<") {
      pos += 2; // skip <<
      let delimiter: string;
      if (script[pos] === "'") {
        pos++; // skip opening quote
        const delimStart = pos;
        while (pos < script.length && script[pos] !== "'" && script[pos] !== "\n") pos++;
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
      let found = false;
      while (pos < script.length) {
        const lineStart = pos;
        while (pos < script.length && script[pos] !== "\n") pos++;
        if (script.slice(lineStart, pos) === delimiter) {
          const value = script.slice(
            contentStart,
            lineStart > contentStart ? lineStart - 1 : lineStart,
          );
          if (pos < script.length) pos++; // skip \n after delimiter
          yield { type: "heredoc", value };
          found = true;
          break;
        }
        if (pos < script.length) pos++; // skip \n
      }
      if (!found) {
        throw new ParseError(`Unterminated heredoc, expected ${delimiter}`);
      }
      continue;
    }

    // word: consume until whitespace
    const start = pos;
    while (pos < script.length && !/\s/.test(script[pos])) pos++;
    yield { type: "word", value: script.slice(start, pos) };
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

function tokenToPattern(tok: Token): Pattern {
  switch (tok.type) {
    case "regex": {
      const flags = tok.flags.includes("g") ? tok.flags : tok.flags + "g";
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
  const iter = lex(script);
  const commands: Command[] = [];

  function next(expected?: string): Token | undefined {
    const result = iter.next();
    if (result.done) {
      if (expected) {
        throw new ParseError(`Expected ${expected}, got end of input`);
      }
      return undefined;
    }
    return result.value;
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
        const pathTok = next("file path")!;
        if (pathTok.type !== "word" && pathTok.type !== "path") {
          throw new ParseError(`Expected file path, got ${pathTok.type}`);
        }
        commands.push({ type: "file", path: pathTok.value });
        break;
      }
      case "newfile": {
        const pathTok = next("file path")!;
        if (pathTok.type !== "word" && pathTok.type !== "path") {
          throw new ParseError(`Expected file path, got ${pathTok.type}`);
        }
        commands.push({ type: "newfile", path: pathTok.value });
        break;
      }

      case "narrow":
      case "narrow_one":
      case "select":
      case "select_one":
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
        const tok = next("heredoc or register name")!;
        if (tok.type === "heredoc") {
          commands.push({ type: "replace", text: tok.value });
        } else if (tok.type === "word") {
          commands.push({ type: "replace", register: tok.value });
        } else {
          throw new ParseError(
            `Expected heredoc or register name after replace, got ${tok.type}`,
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
        const tok = next("heredoc or register name")!;
        if (tok.type === "heredoc") {
          commands.push({ type: cmdTok.value, text: tok.value } as Command);
        } else if (tok.type === "word") {
          commands.push({ type: cmdTok.value, register: tok.value } as Command);
        } else {
          throw new ParseError(
            `Expected heredoc or register name after ${cmdTok.value}, got ${tok.type}`,
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
