import { describe, expect, it } from "vitest";
import { parse } from "./parser.ts";

describe("bash parser", () => {
  describe("simple commands", () => {
    it("should parse a simple command with no args", () => {
      const result = parse("ls");
      expect(result).toEqual({
        commands: [{ executable: "ls", args: [] }],
      });
    });

    it("should parse a command with arguments", () => {
      const result = parse("echo hello world");
      expect(result).toEqual({
        commands: [{ executable: "echo", args: ["hello", "world"] }],
      });
    });

    it("should parse a command with flags", () => {
      const result = parse("npx tsc --noEmit");
      expect(result).toEqual({
        commands: [{ executable: "npx", args: ["tsc", "--noEmit"] }],
      });
    });

    it("should handle quoted arguments", () => {
      const result = parse('echo "hello world"');
      expect(result).toEqual({
        commands: [{ executable: "echo", args: ["hello world"] }],
      });
    });

    it("should handle empty input", () => {
      const result = parse("");
      expect(result).toEqual({ commands: [] });
    });

    it("should handle whitespace-only input", () => {
      const result = parse("   ");
      expect(result).toEqual({ commands: [] });
    });
  });

  describe("command sequences with &&", () => {
    it("should parse two commands with &&", () => {
      const result = parse("cmd1 && cmd2");
      expect(result).toEqual({
        commands: [
          { executable: "cmd1", args: [] },
          { executable: "cmd2", args: [] },
        ],
      });
    });

    it("should parse commands with args separated by &&", () => {
      const result = parse("cd /some/dir && cat file.txt");
      expect(result).toEqual({
        commands: [
          { executable: "cd", args: ["/some/dir"] },
          { executable: "cat", args: ["file.txt"] },
        ],
      });
    });

    it("should parse multiple && commands", () => {
      const result = parse("cmd1 && cmd2 && cmd3");
      expect(result).toEqual({
        commands: [
          { executable: "cmd1", args: [] },
          { executable: "cmd2", args: [] },
          { executable: "cmd3", args: [] },
        ],
      });
    });
  });

  describe("command sequences with ||", () => {
    it("should parse two commands with ||", () => {
      const result = parse("cmd1 || cmd2");
      expect(result).toEqual({
        commands: [
          { executable: "cmd1", args: [] },
          { executable: "cmd2", args: [] },
        ],
      });
    });
  });

  describe("command sequences with ;", () => {
    it("should parse two commands with ;", () => {
      const result = parse("cmd1; cmd2");
      expect(result).toEqual({
        commands: [
          { executable: "cmd1", args: [] },
          { executable: "cmd2", args: [] },
        ],
      });
    });

    it("should handle trailing semicolon", () => {
      const result = parse("cmd1;");
      expect(result).toEqual({
        commands: [{ executable: "cmd1", args: [] }],
      });
    });
  });

  describe("pipelines", () => {
    it("should parse a simple pipeline", () => {
      const result = parse("cat file.txt | grep pattern");
      expect(result).toEqual({
        commands: [
          { executable: "cat", args: ["file.txt"] },
          { executable: "grep", args: ["pattern"] },
        ],
      });
    });

    it("should parse a multi-stage pipeline", () => {
      const result = parse("cat file.txt | grep pattern | head -10");
      expect(result).toEqual({
        commands: [
          { executable: "cat", args: ["file.txt"] },
          { executable: "grep", args: ["pattern"] },
          { executable: "head", args: ["-10"] },
        ],
      });
    });
  });

  describe("mixed operators", () => {
    it("should parse commands with mixed operators", () => {
      const result = parse("cmd1 && cmd2 | cmd3 || cmd4; cmd5");
      expect(result).toEqual({
        commands: [
          { executable: "cmd1", args: [] },
          { executable: "cmd2", args: [] },
          { executable: "cmd3", args: [] },
          { executable: "cmd4", args: [] },
          { executable: "cmd5", args: [] },
        ],
      });
    });
  });

  describe("fd redirections", () => {
    it("should strip 2>&1 redirection", () => {
      const result = parse("npm install 2>&1");
      expect(result).toEqual({
        commands: [{ executable: "npm", args: ["install"] }],
      });
    });

    it("should strip fd redirections between args", () => {
      const result = parse("cmd arg1 2>&1 arg2");
      expect(result).toEqual({
        commands: [{ executable: "cmd", args: ["arg1", "arg2"] }],
      });
    });

    it("should handle multiple redirections", () => {
      const result = parse("cmd 2>&1 1>&2");
      expect(result).toEqual({
        commands: [{ executable: "cmd", args: [] }],
      });
    });
  });

  describe("complex real-world commands", () => {
    it("should parse cd && command pattern", () => {
      const result = parse("cd /project && npx tsc --noEmit");
      expect(result).toEqual({
        commands: [
          { executable: "cd", args: ["/project"] },
          { executable: "npx", args: ["tsc", "--noEmit"] },
        ],
      });
    });

    it("should parse vitest run with files", () => {
      const result = parse(
        "npx vitest run src/test1.spec.ts src/test2.spec.ts",
      );
      expect(result).toEqual({
        commands: [
          {
            executable: "npx",
            args: ["vitest", "run", "src/test1.spec.ts", "src/test2.spec.ts"],
          },
        ],
      });
    });

    it("should parse git commands", () => {
      const result = parse("git add . && git commit -m 'fix'");
      expect(result).toEqual({
        commands: [
          { executable: "git", args: ["add", "."] },
          { executable: "git", args: ["commit", "-m", "fix"] },
        ],
      });
    });

    it("should parse script execution", () => {
      const result = parse("./script.sh arg1 arg2");
      expect(result).toEqual({
        commands: [{ executable: "./script.sh", args: ["arg1", "arg2"] }],
      });
    });

    it("should parse bash script execution", () => {
      const result = parse("bash scripts/run.sh");
      expect(result).toEqual({
        commands: [{ executable: "bash", args: ["scripts/run.sh"] }],
      });
    });

    it("should parse npx tsx script execution", () => {
      const result = parse("npx tsx scripts/generate.ts");
      expect(result).toEqual({
        commands: [{ executable: "npx", args: ["tsx", "scripts/generate.ts"] }],
      });
    });

    it("should parse cd to script dir and execute", () => {
      const result = parse("cd /path/to/scripts && ./run.sh");
      expect(result).toEqual({
        commands: [
          { executable: "cd", args: ["/path/to/scripts"] },
          { executable: "./run.sh", args: [] },
        ],
      });
    });
  });
});
