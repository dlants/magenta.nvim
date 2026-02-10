export type TokenType = "word" | "operator" | "redirect" | "eof";

export type Token = {
  type: TokenType;
  value: string;
};

export class LexerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LexerError";
  }
}

const OPERATORS = ["&&", "||", "|", ";"] as const;
// Only fd-to-fd redirections like 2>&1, 1>&2
const FD_REDIRECT_PATTERN = /^(\d+>&\d+)/;
// File redirections like 2>/dev/null, >file, >>file
const FILE_REDIRECT_PATTERN = /^(\d*>>?|\d*<(?!&))/;

export class Lexer {
  private pos = 0;
  private input: string;

  constructor(input: string) {
    this.input = input;
  }

  tokenize(): Token[] {
    const tokens: Token[] = [];

    while (this.pos < this.input.length) {
      this.skipWhitespace();
      if (this.pos >= this.input.length) break;

      const token = this.nextToken();
      if (token) {
        tokens.push(token);
      }
    }

    tokens.push({ type: "eof", value: "" });
    return tokens;
  }

  private skipWhitespace(): void {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos])) {
      this.pos++;
    }
  }

  private nextToken(): Token | undefined {
    // Check for unsupported features first
    this.checkUnsupportedFeatures();

    // Try to match operators
    const operator = this.tryMatchOperator();
    if (operator) {
      return { type: "operator", value: operator };
    }

    // Try to match redirections
    const redirect = this.tryMatchRedirect();
    if (redirect) {
      return { type: "redirect", value: redirect };
    }

    // Otherwise, parse a word
    const word = this.parseWord();
    if (word !== undefined) {
      return { type: "word", value: word };
    }

    return undefined;
  }

  private checkUnsupportedFeatures(): void {
    const remaining = this.input.slice(this.pos);

    // Command substitution
    if (remaining.startsWith("$(")) {
      throw new LexerError("Command substitution $() is not supported");
    }
    if (remaining.startsWith("`")) {
      throw new LexerError(
        "Command substitution with backticks is not supported",
      );
    }

    // Process substitution
    if (remaining.startsWith("<(") || remaining.startsWith(">(")) {
      throw new LexerError("Process substitution is not supported");
    }

    // Subshells and groups - but only at start of token
    if (remaining.startsWith("(")) {
      throw new LexerError("Subshells are not supported");
    }
    if (remaining.startsWith("{")) {
      throw new LexerError("Brace groups are not supported");
    }

    // Arithmetic expansion
    if (remaining.startsWith("$((")) {
      throw new LexerError("Arithmetic expansion is not supported");
    }

    // Variable expansion (but not inside quotes - handled separately)
    if (/^\$[a-zA-Z_]/.test(remaining) || remaining.startsWith("${")) {
      throw new LexerError("Variable expansion is not supported");
    }
  }

  private tryMatchOperator(): string | undefined {
    for (const op of OPERATORS) {
      if (this.input.slice(this.pos, this.pos + op.length) === op) {
        this.pos += op.length;
        return op;
      }
    }
    return undefined;
  }

  private tryMatchRedirect(): string | undefined {
    const remaining = this.input.slice(this.pos);

    // Check for fd-to-fd redirections like 2>&1 first (more specific)
    const fdMatch = remaining.match(FD_REDIRECT_PATTERN);
    if (fdMatch) {
      this.pos += fdMatch[0].length;
      return fdMatch[0];
    }

    // File redirections like 2>/dev/null, >file, >>file, <file
    const fileMatch = remaining.match(FILE_REDIRECT_PATTERN);
    if (fileMatch) {
      this.pos += fileMatch[0].length;
      let result = fileMatch[0];

      // Skip optional whitespace between operator and target
      this.skipWhitespace();

      // Consume the redirect target (filename)
      const target = this.parseWord();
      if (target === undefined) {
        throw new LexerError("Expected redirect target after " + fileMatch[0]);
      }
      result += target;
      return result;
    }

    return undefined;
  }

  private parseWord(): string | undefined {
    let result = "";

    while (this.pos < this.input.length) {
      const char = this.input[this.pos];

      // Stop at whitespace or operators
      if (/\s/.test(char)) break;
      if (this.isOperatorStart()) break;
      if (this.isRedirectStart()) break;

      if (char === "'") {
        result += this.parseSingleQuoted();
      } else if (char === '"') {
        result += this.parseDoubleQuoted();
      } else if (char === "\\") {
        result += this.parseEscape();
      } else {
        // Check for unsupported features in unquoted context
        this.checkUnsupportedFeatures();
        result += char;
        this.pos++;
      }
    }

    return result.length > 0 ? result : undefined;
  }

  private isOperatorStart(): boolean {
    for (const op of OPERATORS) {
      if (this.input.slice(this.pos, this.pos + op.length) === op) {
        return true;
      }
    }
    return false;
  }

  private isRedirectStart(): boolean {
    const remaining = this.input.slice(this.pos);
    return (
      FD_REDIRECT_PATTERN.test(remaining) ||
      FILE_REDIRECT_PATTERN.test(remaining)
    );
  }

  private parseSingleQuoted(): string {
    this.pos++; // skip opening quote

    let result = "";
    while (this.pos < this.input.length) {
      const char = this.input[this.pos];
      if (char === "'") {
        this.pos++; // skip closing quote
        return result;
      }
      result += char;
      this.pos++;
    }

    throw new LexerError("Unterminated single quote");
  }

  private parseDoubleQuoted(): string {
    this.pos++; // skip opening quote

    let result = "";
    while (this.pos < this.input.length) {
      const char = this.input[this.pos];

      if (char === '"') {
        this.pos++; // skip closing quote
        return result;
      }

      if (char === "\\") {
        this.pos++;
        if (this.pos >= this.input.length) {
          throw new LexerError("Unterminated escape sequence");
        }
        const escaped = this.input[this.pos];
        // In double quotes, only certain characters can be escaped
        if (
          escaped === '"' ||
          escaped === "\\" ||
          escaped === "$" ||
          escaped === "`" ||
          escaped === "\n"
        ) {
          result += escaped;
        } else {
          // Keep the backslash for other characters
          result += "\\" + escaped;
        }
        this.pos++;
        continue;
      }

      // Check for variable expansion inside double quotes
      if (char === "$") {
        const remaining = this.input.slice(this.pos);
        if (
          /^\$[a-zA-Z_]/.test(remaining) ||
          remaining.startsWith("${") ||
          remaining.startsWith("$(") ||
          remaining.startsWith("$((")
        ) {
          throw new LexerError(
            "Variable/command expansion in double quotes is not supported",
          );
        }
      }

      if (char === "`") {
        throw new LexerError(
          "Command substitution with backticks is not supported",
        );
      }

      result += char;
      this.pos++;
    }

    throw new LexerError("Unterminated double quote");
  }

  private parseEscape(): string {
    this.pos++; // skip backslash
    if (this.pos >= this.input.length) {
      // Trailing backslash - in bash this is a line continuation, we'll just return empty
      return "";
    }
    const char = this.input[this.pos];
    this.pos++;
    return char;
  }
}

export function tokenize(input: string): Token[] {
  return new Lexer(input).tokenize();
}
