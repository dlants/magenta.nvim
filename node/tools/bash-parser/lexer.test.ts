import { describe, expect, it } from "vitest";
import { tokenize, LexerError } from "./lexer.ts";

describe("bash lexer", () => {
  describe("basic words", () => {
    it("should tokenize a simple command", () => {
      const tokens = tokenize("echo hello");
      expect(tokens).toEqual([
        { type: "word", value: "echo" },
        { type: "word", value: "hello" },
        { type: "eof", value: "" },
      ]);
    });

    it("should handle multiple arguments", () => {
      const tokens = tokenize("cat file1.txt file2.txt");
      expect(tokens).toEqual([
        { type: "word", value: "cat" },
        { type: "word", value: "file1.txt" },
        { type: "word", value: "file2.txt" },
        { type: "eof", value: "" },
      ]);
    });

    it("should handle extra whitespace", () => {
      const tokens = tokenize("  echo   hello  ");
      expect(tokens).toEqual([
        { type: "word", value: "echo" },
        { type: "word", value: "hello" },
        { type: "eof", value: "" },
      ]);
    });
  });

  describe("operators", () => {
    it("should tokenize && operator", () => {
      const tokens = tokenize("cmd1 && cmd2");
      expect(tokens).toEqual([
        { type: "word", value: "cmd1" },
        { type: "operator", value: "&&" },
        { type: "word", value: "cmd2" },
        { type: "eof", value: "" },
      ]);
    });

    it("should tokenize || operator", () => {
      const tokens = tokenize("cmd1 || cmd2");
      expect(tokens).toEqual([
        { type: "word", value: "cmd1" },
        { type: "operator", value: "||" },
        { type: "word", value: "cmd2" },
        { type: "eof", value: "" },
      ]);
    });

    it("should tokenize | operator", () => {
      const tokens = tokenize("cmd1 | cmd2");
      expect(tokens).toEqual([
        { type: "word", value: "cmd1" },
        { type: "operator", value: "|" },
        { type: "word", value: "cmd2" },
        { type: "eof", value: "" },
      ]);
    });

    it("should tokenize ; operator", () => {
      const tokens = tokenize("cmd1; cmd2");
      expect(tokens).toEqual([
        { type: "word", value: "cmd1" },
        { type: "operator", value: ";" },
        { type: "word", value: "cmd2" },
        { type: "eof", value: "" },
      ]);
    });

    it("should handle operators without spaces", () => {
      const tokens = tokenize("cmd1&&cmd2");
      expect(tokens).toEqual([
        { type: "word", value: "cmd1" },
        { type: "operator", value: "&&" },
        { type: "word", value: "cmd2" },
        { type: "eof", value: "" },
      ]);
    });
  });

  describe("redirections", () => {
    it("should tokenize 2>&1", () => {
      const tokens = tokenize("cmd 2>&1");
      expect(tokens).toEqual([
        { type: "word", value: "cmd" },
        { type: "redirect", value: "2>&1" },
        { type: "eof", value: "" },
      ]);
    });

    it("should tokenize fd redirects", () => {
      const tokens = tokenize("cmd 1>&2");
      expect(tokens).toEqual([
        { type: "word", value: "cmd" },
        { type: "redirect", value: "1>&2" },
        { type: "eof", value: "" },
      ]);
    });

    it("should tokenize > file redirect", () => {
      const tokens = tokenize("cmd > file");
      expect(tokens).toEqual([
        { type: "word", value: "cmd" },
        { type: "redirect", value: ">file" },
        { type: "eof", value: "" },
      ]);
    });

    it("should tokenize >> file redirect", () => {
      const tokens = tokenize("cmd >> file");
      expect(tokens).toEqual([
        { type: "word", value: "cmd" },
        { type: "redirect", value: ">>file" },
        { type: "eof", value: "" },
      ]);
    });

    it("should tokenize < file redirect", () => {
      const tokens = tokenize("cmd < file");
      expect(tokens).toEqual([
        { type: "word", value: "cmd" },
        { type: "redirect", value: "<file" },
        { type: "eof", value: "" },
      ]);
    });

    it("should tokenize 2>/dev/null", () => {
      const tokens = tokenize("cmd 2>/dev/null");
      expect(tokens).toEqual([
        { type: "word", value: "cmd" },
        { type: "redirect", value: "2>/dev/null" },
        { type: "eof", value: "" },
      ]);
    });

    it("should tokenize file redirect with space", () => {
      const tokens = tokenize("cmd 2> /dev/null");
      expect(tokens).toEqual([
        { type: "word", value: "cmd" },
        { type: "redirect", value: "2>/dev/null" },
        { type: "eof", value: "" },
      ]);
    });
  });

  describe("single quotes", () => {
    it("should handle single-quoted strings", () => {
      const tokens = tokenize("echo 'hello world'");
      expect(tokens).toEqual([
        { type: "word", value: "echo" },
        { type: "word", value: "hello world" },
        { type: "eof", value: "" },
      ]);
    });

    it("should preserve special characters in single quotes", () => {
      const tokens = tokenize("echo '$HOME && test'");
      expect(tokens).toEqual([
        { type: "word", value: "echo" },
        { type: "word", value: "$HOME && test" },
        { type: "eof", value: "" },
      ]);
    });

    it("should throw on unterminated single quote", () => {
      expect(() => tokenize("echo 'hello")).toThrow(LexerError);
    });
  });

  describe("double quotes", () => {
    it("should handle double-quoted strings", () => {
      const tokens = tokenize('echo "hello world"');
      expect(tokens).toEqual([
        { type: "word", value: "echo" },
        { type: "word", value: "hello world" },
        { type: "eof", value: "" },
      ]);
    });

    it("should handle escaped quotes in double quotes", () => {
      const tokens = tokenize('echo "say \\"hello\\""');
      expect(tokens).toEqual([
        { type: "word", value: "echo" },
        { type: "word", value: 'say "hello"' },
        { type: "eof", value: "" },
      ]);
    });

    it("should handle escaped backslash in double quotes", () => {
      const tokens = tokenize('echo "path\\\\to\\\\file"');
      expect(tokens).toEqual([
        { type: "word", value: "echo" },
        { type: "word", value: "path\\to\\file" },
        { type: "eof", value: "" },
      ]);
    });

    it("should throw on unterminated double quote", () => {
      expect(() => tokenize('echo "hello')).toThrow(LexerError);
    });

    it("should throw on variable expansion in double quotes", () => {
      expect(() => tokenize('echo "$HOME"')).toThrow(LexerError);
      expect(() => tokenize('echo "${HOME}"')).toThrow(LexerError);
    });

    it("should allow literal $ followed by non-variable characters", () => {
      const tokens = tokenize('echo "$5"');
      expect(tokens).toEqual([
        { type: "word", value: "echo" },
        { type: "word", value: "$5" },
        { type: "eof", value: "" },
      ]);
    });
  });

  describe("escape sequences", () => {
    it("should handle escaped space in unquoted context", () => {
      const tokens = tokenize("cat my\\ file.txt");
      expect(tokens).toEqual([
        { type: "word", value: "cat" },
        { type: "word", value: "my file.txt" },
        { type: "eof", value: "" },
      ]);
    });

    it("should handle escaped special characters", () => {
      const tokens = tokenize("echo \\&\\&");
      expect(tokens).toEqual([
        { type: "word", value: "echo" },
        { type: "word", value: "&&" },
        { type: "eof", value: "" },
      ]);
    });
  });

  describe("quote concatenation", () => {
    it("should concatenate adjacent quoted strings", () => {
      const tokens = tokenize("echo 'foo'\"bar\"baz");
      expect(tokens).toEqual([
        { type: "word", value: "echo" },
        { type: "word", value: "foobarbaz" },
        { type: "eof", value: "" },
      ]);
    });

    it("should concatenate unquoted with quoted", () => {
      const tokens = tokenize("echo foo'bar'");
      expect(tokens).toEqual([
        { type: "word", value: "echo" },
        { type: "word", value: "foobar" },
        { type: "eof", value: "" },
      ]);
    });
  });

  describe("unsupported features", () => {
    it("should throw on command substitution $()", () => {
      expect(() => tokenize("echo $(whoami)")).toThrow(LexerError);
      expect(() => tokenize("echo $(whoami)")).toThrow(/Command substitution/);
    });

    it("should throw on command substitution with backticks", () => {
      expect(() => tokenize("echo `whoami`")).toThrow(LexerError);
      expect(() => tokenize("echo `whoami`")).toThrow(/backticks/);
    });

    it("should throw on variable expansion", () => {
      expect(() => tokenize("echo $HOME")).toThrow(LexerError);
      expect(() => tokenize("echo ${HOME}")).toThrow(LexerError);
    });

    it("should throw on process substitution", () => {
      expect(() => tokenize("diff <(cmd1) >(cmd2)")).toThrow(LexerError);
    });

    it("should throw on subshells", () => {
      expect(() => tokenize("(cmd1; cmd2)")).toThrow(LexerError);
    });

    it("should throw on brace groups", () => {
      expect(() => tokenize("{ cmd1; cmd2; }")).toThrow(LexerError);
    });

    it("should throw on arithmetic expansion", () => {
      expect(() => tokenize("echo $((1+2))")).toThrow(LexerError);
    });
  });

  describe("complex commands", () => {
    it("should handle cd && command pattern", () => {
      const tokens = tokenize("cd /some/dir && cat file.txt");
      expect(tokens).toEqual([
        { type: "word", value: "cd" },
        { type: "word", value: "/some/dir" },
        { type: "operator", value: "&&" },
        { type: "word", value: "cat" },
        { type: "word", value: "file.txt" },
        { type: "eof", value: "" },
      ]);
    });

    it("should handle npx command", () => {
      const tokens = tokenize("npx tsc --noEmit");
      expect(tokens).toEqual([
        { type: "word", value: "npx" },
        { type: "word", value: "tsc" },
        { type: "word", value: "--noEmit" },
        { type: "eof", value: "" },
      ]);
    });

    it("should handle command with 2>&1 redirect", () => {
      const tokens = tokenize("npm install 2>&1");
      expect(tokens).toEqual([
        { type: "word", value: "npm" },
        { type: "word", value: "install" },
        { type: "redirect", value: "2>&1" },
        { type: "eof", value: "" },
      ]);
    });

    it("should handle pipeline", () => {
      const tokens = tokenize("cat file.txt | grep pattern | head -10");
      expect(tokens).toEqual([
        { type: "word", value: "cat" },
        { type: "word", value: "file.txt" },
        { type: "operator", value: "|" },
        { type: "word", value: "grep" },
        { type: "word", value: "pattern" },
        { type: "operator", value: "|" },
        { type: "word", value: "head" },
        { type: "word", value: "-10" },
        { type: "eof", value: "" },
      ]);
    });
  });
});
