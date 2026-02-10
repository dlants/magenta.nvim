import type { Token } from "./lexer.ts";
import { tokenize } from "./lexer.ts";

export type FileRedirect = {
  target: string;
  direction: "input" | "output";
};

export type ParsedCommand = {
  executable: string;
  args: string[];
  receivingPipe: boolean;
  fileRedirects: FileRedirect[];
};

export type ParsedCommandList = {
  commands: ParsedCommand[];
};

export class ParserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParserError";
  }
}

export class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): ParsedCommandList {
    const commands: ParsedCommand[] = [];
    let lastOperator: string | undefined;

    while (!this.isAtEnd()) {
      // Skip any leading operators (e.g., from empty command after ;)
      if (this.peek().type === "operator") {
        lastOperator = this.advance().value;
        continue;
      }

      const receivingPipe = lastOperator === "|";
      const command = this.parseCommand(receivingPipe);
      if (command) {
        commands.push(command);
      }

      // After a command, we expect either an operator or end
      if (!this.isAtEnd() && this.peek().type === "operator") {
        lastOperator = this.advance().value;
      } else {
        lastOperator = undefined;
      }
    }

    return { commands };
  }

  private static FD_REDIRECT_RE = /^\d+>&\d+$/;
  private static FILE_REDIRECT_RE = /^(\d*>>?|\d*<(?!&))(.+)$/;

  private parseFileRedirect(value: string): FileRedirect | undefined {
    if (Parser.FD_REDIRECT_RE.test(value)) {
      return undefined;
    }
    const match = value.match(Parser.FILE_REDIRECT_RE);
    if (!match) {
      return undefined;
    }
    const [, op, target] = match;
    return {
      target,
      direction: op.includes("<") ? "input" : "output",
    };
  }

  private parseCommand(receivingPipe: boolean): ParsedCommand | undefined {
    const fileRedirects: FileRedirect[] = [];

    // Skip any redirections at the start
    this.collectRedirects(fileRedirects);

    if (this.isAtEnd() || this.peek().type === "operator") {
      return undefined;
    }

    // First word is the executable
    const execToken = this.peek();
    if (execToken.type !== "word") {
      throw new ParserError(
        `Expected command executable, got ${execToken.type}: ${execToken.value}`,
      );
    }
    this.advance();

    const executable = execToken.value;
    const args: string[] = [];

    // Collect arguments until we hit an operator or end
    while (!this.isAtEnd()) {
      const token = this.peek();

      if (token.type === "operator") {
        break;
      }

      if (token.type === "redirect") {
        const fileRedirect = this.parseFileRedirect(token.value);
        if (fileRedirect) {
          fileRedirects.push(fileRedirect);
        }
        this.advance();
        continue;
      }

      if (token.type === "word") {
        args.push(token.value);
        this.advance();
        continue;
      }

      // eof
      break;
    }

    return { executable, args, receivingPipe, fileRedirects };
  }

  private collectRedirects(fileRedirects: FileRedirect[]): void {
    while (!this.isAtEnd() && this.peek().type === "redirect") {
      const token = this.advance();
      const fileRedirect = this.parseFileRedirect(token.value);
      if (fileRedirect) {
        fileRedirects.push(fileRedirect);
      }
    }
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const token = this.tokens[this.pos];
    this.pos++;
    return token;
  }

  private isAtEnd(): boolean {
    return (
      this.pos >= this.tokens.length || this.tokens[this.pos].type === "eof"
    );
  }
}

export function parse(input: string): ParsedCommandList {
  const tokens = tokenize(input);
  return new Parser(tokens).parse();
}
