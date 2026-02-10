import { describe, expect, it } from "vitest";
import { parse } from "./parser.ts";

describe("bash parser", () => {
  describe("simple commands", () => {
    it("should parse a simple command with no args", () => {
      const result = parse("ls");
      expect(result).toEqual({
        commands: [
          {
            executable: "ls",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });

    it("should parse a command with arguments", () => {
      const result = parse("echo hello world");
      expect(result).toEqual({
        commands: [
          {
            executable: "echo",
            args: ["hello", "world"],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });

    it("should parse a command with flags", () => {
      const result = parse("npx tsc --noEmit");
      expect(result).toEqual({
        commands: [
          {
            executable: "npx",
            args: ["tsc", "--noEmit"],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });

    it("should handle quoted arguments", () => {
      const result = parse('echo "hello world"');
      expect(result).toEqual({
        commands: [
          {
            executable: "echo",
            args: ["hello world"],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
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
          {
            executable: "cmd1",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
          {
            executable: "cmd2",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });

    it("should parse commands with args separated by &&", () => {
      const result = parse("cd /some/dir && cat file.txt");
      expect(result).toEqual({
        commands: [
          {
            executable: "cd",
            args: ["/some/dir"],
            receivingPipe: false,
            fileRedirects: [],
          },
          {
            executable: "cat",
            args: ["file.txt"],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });

    it("should parse multiple && commands", () => {
      const result = parse("cmd1 && cmd2 && cmd3");
      expect(result).toEqual({
        commands: [
          {
            executable: "cmd1",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
          {
            executable: "cmd2",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
          {
            executable: "cmd3",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });
  });

  describe("command sequences with ||", () => {
    it("should parse two commands with ||", () => {
      const result = parse("cmd1 || cmd2");
      expect(result).toEqual({
        commands: [
          {
            executable: "cmd1",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
          {
            executable: "cmd2",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });
  });

  describe("command sequences with ;", () => {
    it("should parse two commands with ;", () => {
      const result = parse("cmd1; cmd2");
      expect(result).toEqual({
        commands: [
          {
            executable: "cmd1",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
          {
            executable: "cmd2",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });

    it("should handle trailing semicolon", () => {
      const result = parse("cmd1;");
      expect(result).toEqual({
        commands: [
          {
            executable: "cmd1",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });
  });

  describe("pipelines", () => {
    it("should parse a simple pipeline", () => {
      const result = parse("cat file.txt | grep pattern");
      expect(result).toEqual({
        commands: [
          {
            executable: "cat",
            args: ["file.txt"],
            receivingPipe: false,
            fileRedirects: [],
          },
          {
            executable: "grep",
            args: ["pattern"],
            receivingPipe: true,
            fileRedirects: [],
          },
        ],
      });
    });

    it("should parse a multi-stage pipeline", () => {
      const result = parse("cat file.txt | grep pattern | head -10");
      expect(result).toEqual({
        commands: [
          {
            executable: "cat",
            args: ["file.txt"],
            receivingPipe: false,
            fileRedirects: [],
          },
          {
            executable: "grep",
            args: ["pattern"],
            receivingPipe: true,
            fileRedirects: [],
          },
          {
            executable: "head",
            args: ["-10"],
            receivingPipe: true,
            fileRedirects: [],
          },
        ],
      });
    });
  });

  describe("mixed operators", () => {
    it("should parse commands with mixed operators", () => {
      const result = parse("cmd1 && cmd2 | cmd3 || cmd4; cmd5");
      expect(result).toEqual({
        commands: [
          {
            executable: "cmd1",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
          {
            executable: "cmd2",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
          {
            executable: "cmd3",
            args: [],
            receivingPipe: true,
            fileRedirects: [],
          },
          {
            executable: "cmd4",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
          {
            executable: "cmd5",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });
  });

  describe("fd redirections", () => {
    it("should strip 2>&1 redirection", () => {
      const result = parse("npm install 2>&1");
      expect(result).toEqual({
        commands: [
          {
            executable: "npm",
            args: ["install"],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });

    it("should strip fd redirections between args", () => {
      const result = parse("cmd arg1 2>&1 arg2");
      expect(result).toEqual({
        commands: [
          {
            executable: "cmd",
            args: ["arg1", "arg2"],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });

    it("should handle multiple redirections", () => {
      const result = parse("cmd 2>&1 1>&2");
      expect(result).toEqual({
        commands: [
          {
            executable: "cmd",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });
  });

  describe("file redirections", () => {
    it("should parse output redirect to /dev/null", () => {
      const result = parse("cmd 2>/dev/null");
      expect(result).toEqual({
        commands: [
          {
            executable: "cmd",
            args: [],
            receivingPipe: false,
            fileRedirects: [{ target: "/dev/null", direction: "output" }],
          },
        ],
      });
    });

    it("should parse input redirect", () => {
      const result = parse("cmd < input.txt");
      expect(result).toEqual({
        commands: [
          {
            executable: "cmd",
            args: [],
            receivingPipe: false,
            fileRedirects: [{ target: "input.txt", direction: "input" }],
          },
        ],
      });
    });

    it("should parse output redirect to file", () => {
      const result = parse("cmd > output.txt");
      expect(result).toEqual({
        commands: [
          {
            executable: "cmd",
            args: [],
            receivingPipe: false,
            fileRedirects: [{ target: "output.txt", direction: "output" }],
          },
        ],
      });
    });

    it("should not include fd-to-fd redirects in fileRedirects", () => {
      const result = parse("cmd 2>&1");
      expect(result).toEqual({
        commands: [
          {
            executable: "cmd",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });

    it("should parse multiple redirects", () => {
      const result = parse("cmd 2>/dev/null > output.txt");
      expect(result).toEqual({
        commands: [
          {
            executable: "cmd",
            args: [],
            receivingPipe: false,
            fileRedirects: [
              { target: "/dev/null", direction: "output" },
              { target: "output.txt", direction: "output" },
            ],
          },
        ],
      });
    });
  });
  describe("complex real-world commands", () => {
    it("should parse cd && command pattern", () => {
      const result = parse("cd /project && npx tsc --noEmit");
      expect(result).toEqual({
        commands: [
          {
            executable: "cd",
            args: ["/project"],
            receivingPipe: false,
            fileRedirects: [],
          },
          {
            executable: "npx",
            args: ["tsc", "--noEmit"],
            receivingPipe: false,
            fileRedirects: [],
          },
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
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });

    it("should parse git commands", () => {
      const result = parse("git add . && git commit -m 'fix'");
      expect(result).toEqual({
        commands: [
          {
            executable: "git",
            args: ["add", "."],
            receivingPipe: false,
            fileRedirects: [],
          },
          {
            executable: "git",
            args: ["commit", "-m", "fix"],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });

    it("should parse script execution", () => {
      const result = parse("./script.sh arg1 arg2");
      expect(result).toEqual({
        commands: [
          {
            executable: "./script.sh",
            args: ["arg1", "arg2"],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });

    it("should parse bash script execution", () => {
      const result = parse("bash scripts/run.sh");
      expect(result).toEqual({
        commands: [
          {
            executable: "bash",
            args: ["scripts/run.sh"],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });

    it("should parse npx tsx script execution", () => {
      const result = parse("npx tsx scripts/generate.ts");
      expect(result).toEqual({
        commands: [
          {
            executable: "npx",
            args: ["tsx", "scripts/generate.ts"],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });

    it("should parse cd to script dir and execute", () => {
      const result = parse("cd /path/to/scripts && ./run.sh");
      expect(result).toEqual({
        commands: [
          {
            executable: "cd",
            args: ["/path/to/scripts"],
            receivingPipe: false,
            fileRedirects: [],
          },
          {
            executable: "./run.sh",
            args: [],
            receivingPipe: false,
            fileRedirects: [],
          },
        ],
      });
    });
  });
});
