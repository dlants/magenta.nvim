import { describe, it, test, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { NvimCwd, HomeDir } from "../../utils/files.ts";
import {
  isCommandAllowedByConfig,
  checkCommandListPermissions,
  BUILTIN_COMMAND_PERMISSIONS,
  type CommandPermissions,
} from "./permissions.ts";
import { parse } from "./parser.ts";

const homeDir = "/home/user" as HomeDir;

describe("permissions", () => {
  let testDir: string;
  let cwd: NvimCwd;
  let skillsDir: string;

  beforeEach(() => {
    // Create a temp directory for tests
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-permissions-test-"));
    cwd = testDir as NvimCwd;

    // Create skills directory with a test script
    skillsDir = path.join(testDir, ".magenta", "skills", "test-skill");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "script.sh"),
      "#!/bin/bash\necho hello",
    );
    fs.writeFileSync(path.join(skillsDir, "script.ts"), "console.log('hello')");

    // Create some test files
    fs.writeFileSync(path.join(testDir, "file.txt"), "test content");
    fs.writeFileSync(path.join(testDir, "other.txt"), "other content");
    fs.mkdirSync(path.join(testDir, "subdir"));
    fs.writeFileSync(path.join(testDir, "subdir", "nested.txt"), "nested");

    // Create a hidden directory
    fs.mkdirSync(path.join(testDir, ".hidden"));
    fs.writeFileSync(path.join(testDir, ".hidden", "secret.txt"), "secret");
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe("basic command matching", () => {
    it("should allow configured command with no args", () => {
      const config: CommandPermissions = {
        commands: [["ls"]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("ls", config, {
        cwd,
        homeDir,
      });
      expect(result.allowed).toBe(true);
    });

    it("should reject unconfigured command", () => {
      const config: CommandPermissions = {
        commands: [["ls"]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("rm -rf /", config, {
        cwd,
        homeDir,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("rm");
    });

    it("should allow command with exact literal args", () => {
      const config: CommandPermissions = {
        commands: [
          ["npx", "tsc", "--noEmit"],
          ["npx", "tsc", "--noEmit", "--watch"],
        ],
        pipeCommands: [],
      };

      const result1 = isCommandAllowedByConfig("npx tsc --noEmit", config, {
        homeDir,
        cwd,
      });
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowedByConfig(
        "npx tsc --noEmit --watch",
        config,
        { cwd, homeDir },
      );
      expect(result2.allowed).toBe(true);
    });

    it("should reject command with wrong arg order", () => {
      const config: CommandPermissions = {
        commands: [["npx", "tsc", "--noEmit", "--watch"]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig(
        "npx tsc --watch --noEmit",
        config,
        {
          homeDir,
          cwd,
        },
      );
      expect(result.allowed).toBe(false);
    });

    it("should reject command with extra args", () => {
      const config: CommandPermissions = {
        commands: [["npx", "tsc", "--noEmit"]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig(
        "npx tsc --noEmit --extra",
        config,
        {
          homeDir,
          cwd,
        },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("extra");
    });
  });

  describe("file argument matching", () => {
    it("should allow command with safe file path", () => {
      const config: CommandPermissions = {
        commands: [["cat", { type: "file" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("cat file.txt", config, {
        homeDir,
        cwd,
      });
      expect(result.allowed).toBe(true);
    });

    it("should allow command with nested file path", () => {
      const config: CommandPermissions = {
        commands: [["cat", { type: "file" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("cat subdir/nested.txt", config, {
        cwd,
        homeDir,
      });
      expect(result.allowed).toBe(true);
    });

    it("should reject file outside cwd", () => {
      const config: CommandPermissions = {
        commands: [["cat", { type: "file" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("cat /etc/passwd", config, {
        homeDir,
        cwd,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("no read permission");
    });

    it("should reject file in hidden directory", () => {
      const config: CommandPermissions = {
        commands: [["cat", { type: "file" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig(
        "cat .hidden/secret.txt",
        config,
        {
          homeDir,
          cwd,
        },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("hidden");
    });

    it("should reject file traversing outside cwd", () => {
      const config: CommandPermissions = {
        commands: [["cat", { type: "file" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig(
        "cat ../../../etc/passwd",
        config,
        { cwd, homeDir },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("no read permission");
    });
  });

  describe("any (wildcard) argument matching", () => {
    it("should allow command with any single argument", () => {
      const config: CommandPermissions = {
        commands: [["head", "-n", { type: "any" }, { type: "file" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("head -n 10 file.txt", config, {
        homeDir,
        cwd,
      });
      expect(result.allowed).toBe(true);
    });

    it("should allow any value for wildcard argument", () => {
      const config: CommandPermissions = {
        commands: [["head", "-n", { type: "any" }, { type: "file" }]],
        pipeCommands: [],
      };

      const result1 = isCommandAllowedByConfig("head -n 100 file.txt", config, {
        homeDir,
        cwd,
      });
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowedByConfig("head -n abc file.txt", config, {
        homeDir,
        cwd,
      });
      expect(result2.allowed).toBe(true);
    });

    it("should reject when wildcard argument is missing", () => {
      const config: CommandPermissions = {
        commands: [["head", "-n", { type: "any" }, { type: "file" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("head -n file.txt", config, {
        homeDir,
        cwd,
      });
      // This should fail because -n expects a value, so file.txt would be the value
      // and then there's no file argument
      expect(result.allowed).toBe(false);
    });

    it("should work with just flag and wildcard (no file)", () => {
      const config: CommandPermissions = {
        commands: [["test", "-n", { type: "any" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("test -n 42", config, {
        cwd,
        homeDir,
      });
      expect(result.allowed).toBe(true);
    });

    it("should reject extra arguments after wildcard", () => {
      const config: CommandPermissions = {
        commands: [["test", "-n", { type: "any" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("test -n 42 extra", config, {
        homeDir,
        cwd,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("extra");
    });
  });

  describe("pattern argument matching", () => {
    it("should allow argument matching regex pattern", () => {
      const config: CommandPermissions = {
        commands: [["head", { type: "pattern", pattern: "-[0-9]+" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("head -50", config, {
        homeDir,
        cwd,
      });
      expect(result.allowed).toBe(true);
    });

    it("should reject argument not matching pattern", () => {
      const config: CommandPermissions = {
        commands: [["head", { type: "pattern", pattern: "-[0-9]+" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("head -abc", config, {
        homeDir,
        cwd,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not match pattern");
    });

    it("should match full argument with pattern (anchored)", () => {
      const config: CommandPermissions = {
        commands: [["head", { type: "pattern", pattern: "-[0-9]+" }]],
        pipeCommands: [],
      };

      // -50abc should not match because pattern is anchored
      const result = isCommandAllowedByConfig("head -50abc", config, {
        homeDir,
        cwd,
      });
      expect(result.allowed).toBe(false);
    });

    it("should work with pattern followed by file", () => {
      const config: CommandPermissions = {
        commands: [
          ["head", { type: "pattern", pattern: "-[0-9]+" }, { type: "file" }],
        ],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("head -10 file.txt", config, {
        homeDir,
        cwd,
      });
      expect(result.allowed).toBe(true);
    });

    it("should support multiple arg patterns including pattern", () => {
      const config: CommandPermissions = {
        commands: [
          ["tail", "-n", { type: "any" }],
          ["tail", { type: "pattern", pattern: "-[0-9]+" }],
        ],
        pipeCommands: [],
      };

      const result1 = isCommandAllowedByConfig("tail -n 5", config, {
        homeDir,
        cwd,
      });
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowedByConfig("tail -5", config, {
        homeDir,
        cwd,
      });
      expect(result2.allowed).toBe(true);
    });
  });

  describe("restFiles argument matching", () => {
    it("should allow multiple file arguments with restFiles", () => {
      const config: CommandPermissions = {
        commands: [["npx", "vitest", "run", { type: "restFiles" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig(
        "npx vitest run file.txt subdir/nested.txt",
        config,
        { cwd, homeDir },
      );
      expect(result.allowed).toBe(true);
    });

    it("should allow zero files with restFiles", () => {
      const config: CommandPermissions = {
        commands: [["npx", "vitest", "run", { type: "restFiles" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("npx vitest run", config, {
        homeDir,
        cwd,
      });
      expect(result.allowed).toBe(true);
    });

    it("should reject if any file in restFiles is unsafe", () => {
      const config: CommandPermissions = {
        commands: [["cat", { type: "restFiles" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig(
        "cat file.txt /etc/passwd",
        config,
        { cwd, homeDir },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("no read permission");
    });
  });

  describe("command chaining with cwd tracking", () => {
    it("should track cwd through cd commands", () => {
      const config: CommandPermissions = {
        commands: [["cat", { type: "file" }]],
        pipeCommands: [],
      };

      // cd to subdir then cat nested.txt (which is now just nested.txt relative to subdir)
      const result = isCommandAllowedByConfig(
        "cd subdir && cat nested.txt",
        config,
        { cwd, homeDir },
      );
      expect(result.allowed).toBe(true);
    });

    it("should reject when cd goes outside project", () => {
      const config: CommandPermissions = {
        commands: [["cat", { type: "file" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("cd .. && cat file.txt", config, {
        homeDir,
        cwd,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("no read permission");
    });

    it("should handle multiple commands in sequence", () => {
      const config: CommandPermissions = {
        commands: [
          ["echo", { type: "restFiles" }],
          ["cat", { type: "file" }],
        ],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig(
        "echo hello && cat file.txt",
        config,
        { cwd, homeDir },
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("skills script execution", () => {
    it("should allow direct script execution from skills directory", () => {
      const config: CommandPermissions = { commands: [], pipeCommands: [] };
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      const result = isCommandAllowedByConfig(
        "./.magenta/skills/test-skill/script.sh",
        config,
        { cwd, homeDir, skillsPaths },
      );
      expect(result.allowed).toBe(true);
    });

    it("should allow bash script.sh from skills directory", () => {
      const config: CommandPermissions = { commands: [], pipeCommands: [] };
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      const result = isCommandAllowedByConfig(
        "bash .magenta/skills/test-skill/script.sh",
        config,
        { cwd, homeDir, skillsPaths },
      );
      expect(result.allowed).toBe(true);
    });

    it("should allow npx tsx script.ts from skills directory", () => {
      const config: CommandPermissions = { commands: [], pipeCommands: [] };
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      const result = isCommandAllowedByConfig(
        "npx tsx .magenta/skills/test-skill/script.ts",
        config,
        { cwd, homeDir, skillsPaths },
      );
      expect(result.allowed).toBe(true);
    });

    it("should allow pkgx tsx script.ts from skills directory", () => {
      const config: CommandPermissions = { commands: [], pipeCommands: [] };
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      const result = isCommandAllowedByConfig(
        "pkgx tsx .magenta/skills/test-skill/script.ts",
        config,
        { cwd, homeDir, skillsPaths },
      );
      expect(result.allowed).toBe(true);
    });

    it("should allow pkgx python script.py from skills directory", () => {
      const config: CommandPermissions = { commands: [], pipeCommands: [] };
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      // Create a python script in skills directory
      fs.writeFileSync(path.join(skillsDir, "script.py"), "print('hello')");

      const result = isCommandAllowedByConfig(
        "pkgx python .magenta/skills/test-skill/script.py",
        config,
        { cwd, homeDir, skillsPaths },
      );
      expect(result.allowed).toBe(true);
    });

    it("should allow cd to skills dir && ./script.sh", () => {
      const config: CommandPermissions = { commands: [], pipeCommands: [] };
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      const result = isCommandAllowedByConfig(
        "cd .magenta/skills/test-skill && ./script.sh",
        config,
        { cwd, homeDir, skillsPaths },
      );
      expect(result.allowed).toBe(true);
    });

    it("should not allow non-skills script execution", () => {
      const config: CommandPermissions = { commands: [], pipeCommands: [] };
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      // Create a non-skills script
      fs.writeFileSync(
        path.join(testDir, "malicious.sh"),
        "#!/bin/bash\nrm -rf /",
      );

      const result = isCommandAllowedByConfig("./malicious.sh", config, {
        homeDir,
        cwd,
        skillsPaths,
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe("parse errors", () => {
    it("should reject commands with unsupported features", () => {
      const config: CommandPermissions = {
        commands: [["echo", { type: "restFiles" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("echo $(whoami)", config, {
        homeDir,
        cwd,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("failed to parse");
    });

    it("should reject commands with variable expansion", () => {
      const config: CommandPermissions = {
        commands: [["echo", { type: "restFiles" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("echo $HOME", config, {
        homeDir,
        cwd,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("failed to parse");
    });
  });

  describe("restAny configuration", () => {
    it("should allow command with any arguments when restAny is used", () => {
      const config: CommandPermissions = {
        commands: [["echo", { type: "restAny" }]],
        pipeCommands: [],
      };

      const result1 = isCommandAllowedByConfig("echo hello world", config, {
        homeDir,
        cwd,
      });
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowedByConfig(
        "echo --flag -x arg1 arg2",
        config,
        { cwd, homeDir },
      );
      expect(result2.allowed).toBe(true);

      const result3 = isCommandAllowedByConfig("echo", config, {
        homeDir,
        cwd,
      });
      expect(result3.allowed).toBe(true);
    });

    it("should allow subcommand with any arguments when restAny is used", () => {
      const config: CommandPermissions = {
        commands: [["npm", "run", { type: "restAny" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig(
        "npm run test --coverage --watch",
        config,
        { cwd, homeDir },
      );
      expect(result.allowed).toBe(true);
    });

    it("should still require correct subcommand even with restAny after it", () => {
      const config: CommandPermissions = {
        commands: [["npm", "run", { type: "restAny" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("npm install lodash", config, {
        homeDir,
        cwd,
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe("chaining security", () => {
    it("should reject chaining restAny command with non-allowlisted command", () => {
      const config: CommandPermissions = {
        commands: [["echo", { type: "restAny" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig(
        "echo hello && rm -rf /",
        config,
        {
          homeDir,
          cwd,
        },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("rm");
    });

    it("should reject chaining skills script with non-allowlisted command", () => {
      const config: CommandPermissions = { commands: [], pipeCommands: [] };
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      const result = isCommandAllowedByConfig(
        "./.magenta/skills/test-skill/script.sh && rm -rf /",
        config,
        { cwd, homeDir, skillsPaths },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("rm");
    });

    it("should reject piping restAny command to non-allowlisted command", () => {
      const config: CommandPermissions = {
        commands: [["echo", { type: "restAny" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("echo hello | xargs rm", config, {
        homeDir,
        cwd,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("xargs");
    });

    it("should reject OR-chaining restAny command with non-allowlisted command", () => {
      const config: CommandPermissions = {
        commands: [["echo", { type: "restAny" }]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig(
        "echo hello || malicious_cmd",
        config,
        { cwd, homeDir },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("malicious_cmd");
    });

    it("should allow chaining multiple allowlisted commands", () => {
      const config: CommandPermissions = {
        commands: [["echo", { type: "restAny" }], ["ls"]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("echo hello && ls", config, {
        cwd,
        homeDir,
      });
      expect(result.allowed).toBe(true);
    });

    it("should allow chaining skills script with allowlisted command", () => {
      const config: CommandPermissions = {
        commands: [["echo", { type: "restAny" }]],
        pipeCommands: [],
      };
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      const result = isCommandAllowedByConfig(
        "./.magenta/skills/test-skill/script.sh && echo done",
        config,
        { cwd, homeDir, skillsPaths },
      );
      expect(result.allowed).toBe(true);
    });

    it("should allow chaining multiple skills scripts", () => {
      const config: CommandPermissions = { commands: [], pipeCommands: [] };
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      // Create a second script
      fs.writeFileSync(
        path.join(skillsDir, "script2.sh"),
        "#!/bin/bash\necho world",
      );

      const result = isCommandAllowedByConfig(
        "./.magenta/skills/test-skill/script.sh && ./.magenta/skills/test-skill/script2.sh",
        config,
        { cwd, homeDir, skillsPaths },
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("group argument matching", () => {
    it("should allow command when optional group is present", () => {
      const config: CommandPermissions = {
        commands: [
          [
            "grep",
            { type: "group", optional: true, args: ["-v", { type: "any" }] },
            { type: "file" },
          ],
        ],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig(
        "grep -v 'pattern' file.txt",
        config,
        { cwd, homeDir },
      );
      expect(result.allowed).toBe(true);
    });

    it("should allow command when optional group is absent", () => {
      const config: CommandPermissions = {
        commands: [
          [
            "grep",
            { type: "group", optional: true, args: ["-v", { type: "any" }] },
            { type: "file" },
          ],
        ],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("grep file.txt", config, {
        cwd,
        homeDir,
      });
      expect(result.allowed).toBe(true);
    });

    it("should reject when optional group is partially present", () => {
      const config: CommandPermissions = {
        commands: [
          [
            "grep",
            { type: "group", optional: true, args: ["-v", { type: "any" }] },
            { type: "file" },
          ],
        ],
        pipeCommands: [],
      };

      // -v without a pattern - this will actually match -v as the file, which will fail path check
      const result = isCommandAllowedByConfig("grep -v file.txt", config, {
        homeDir,
        cwd,
      });
      // This should fail because -v doesn't look like a file path initially,
      // but the optional group requires both -v and a pattern
      expect(result.allowed).toBe(false);
    });

    it("should handle multiple optional groups", () => {
      const config: CommandPermissions = {
        commands: [
          [
            "cmd",
            { type: "group", optional: true, args: ["-a", { type: "any" }] },
            { type: "group", optional: true, args: ["-b", { type: "any" }] },
            { type: "file" },
          ],
        ],
        pipeCommands: [],
      };

      const result1 = isCommandAllowedByConfig("cmd file.txt", config, {
        cwd,
        homeDir,
      });
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowedByConfig("cmd -a foo file.txt", config, {
        cwd,
        homeDir,
      });
      expect(result2.allowed).toBe(true);

      const result3 = isCommandAllowedByConfig("cmd -b bar file.txt", config, {
        cwd,
        homeDir,
      });
      expect(result3.allowed).toBe(true);

      const result4 = isCommandAllowedByConfig(
        "cmd -a foo -b bar file.txt",
        config,
        { cwd, homeDir },
      );
      expect(result4.allowed).toBe(true);
    });

    it("should validate file paths inside groups", () => {
      const config: CommandPermissions = {
        commands: [
          [
            "cmd",
            { type: "group", optional: true, args: ["-f", { type: "file" }] },
          ],
        ],
        pipeCommands: [],
      };

      const result1 = isCommandAllowedByConfig("cmd -f file.txt", config, {
        cwd,
        homeDir,
      });
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowedByConfig("cmd -f /etc/passwd", config, {
        cwd,
        homeDir,
      });
      // Optional group should not match because file path is unsafe,
      // but since there's no other args pattern, it fails
      expect(result2.allowed).toBe(false);
    });

    it("should handle optional group with single literal arg", () => {
      const config: CommandPermissions = {
        commands: [
          [
            "test",
            { type: "group", optional: true, args: ["--verbose"] },
            { type: "file" },
          ],
        ],
        pipeCommands: [],
      };

      const result1 = isCommandAllowedByConfig("test file.txt", config, {
        cwd,
        homeDir,
      });
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowedByConfig(
        "test --verbose file.txt",
        config,
        { cwd, homeDir },
      );
      expect(result2.allowed).toBe(true);
    });

    it("should reject restFiles inside group", () => {
      const config: CommandPermissions = {
        commands: [
          [
            "cmd",
            {
              type: "group",
              optional: true,
              args: ["-f", { type: "restFiles" }],
            },
          ],
        ],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig("cmd -f file.txt", config, {
        cwd,
        homeDir,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("restFiles not allowed inside group");
    });

    it("should work with optional group followed by restFiles", () => {
      const config: CommandPermissions = {
        commands: [
          [
            "rg",
            { type: "group", optional: true, args: ["-v", { type: "any" }] },
            { type: "restFiles" },
          ],
        ],
        pipeCommands: [],
      };

      const result1 = isCommandAllowedByConfig("rg file.txt", config, {
        cwd,
        homeDir,
      });
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowedByConfig(
        "rg -v 'pattern' file.txt other.txt",
        config,
        { cwd, homeDir },
      );
      expect(result2.allowed).toBe(true);

      const result3 = isCommandAllowedByConfig("rg", config, {
        cwd,
        homeDir,
      });
      expect(result3.allowed).toBe(true);
    });

    it("should handle anyOrder groups", () => {
      const config: CommandPermissions = {
        commands: [
          [
            "cmd",
            {
              type: "group",
              anyOrder: true,
              args: [
                { type: "group", optional: true, args: ["-l"] },
                {
                  type: "group",
                  optional: true,
                  args: ["-v", { type: "any" }],
                },
              ],
            },
            { type: "file" },
          ],
        ],
        pipeCommands: [],
      };

      // Just -l
      const result1 = isCommandAllowedByConfig("cmd -l file.txt", config, {
        cwd,
        homeDir,
      });
      expect(result1.allowed).toBe(true);

      // Just -v pattern
      const result2 = isCommandAllowedByConfig("cmd -v foo file.txt", config, {
        cwd,
        homeDir,
      });
      expect(result2.allowed).toBe(true);

      // -l then -v pattern
      const result3 = isCommandAllowedByConfig(
        "cmd -l -v foo file.txt",
        config,
        {
          cwd,
          homeDir,
        },
      );
      expect(result3.allowed).toBe(true);

      // -v pattern then -l (reversed order)
      const result4 = isCommandAllowedByConfig(
        "cmd -v foo -l file.txt",
        config,
        {
          cwd,
          homeDir,
        },
      );
      expect(result4.allowed).toBe(true);

      // Neither optional
      const result5 = isCommandAllowedByConfig("cmd file.txt", config, {
        cwd,
        homeDir,
      });
      expect(result5.allowed).toBe(true);
    });
  });

  describe("complex configurations", () => {
    it("should handle subcommands with file args", () => {
      const config: CommandPermissions = {
        commands: [["git", "add", { type: "restFiles" }]],
        pipeCommands: [],
      };

      // Should allow adding files in the project
      const result1 = isCommandAllowedByConfig("git add file.txt", config, {
        cwd,
        homeDir,
      });
      expect(result1.allowed).toBe(true);

      // Should reject adding files outside the project
      const result2 = isCommandAllowedByConfig("git add /etc/passwd", config, {
        cwd,
        homeDir,
      });
      expect(result2.allowed).toBe(false);
      expect(result2.reason).toContain("no read permission");
    });

    it("should handle deeply nested subcommands", () => {
      const config: CommandPermissions = {
        commands: [["git", "remote", "add", "origin", "url"]],
        pipeCommands: [],
      };

      const result = isCommandAllowedByConfig(
        "git remote add origin url",
        config,
        { cwd, homeDir },
      );
      expect(result.allowed).toBe(true);
    });

    it("should match first valid pattern", () => {
      const config: CommandPermissions = {
        commands: [
          ["test", "--flag"],
          ["test", { type: "file" }],
          ["test", "--flag", { type: "file" }],
        ],
        pipeCommands: [],
      };

      const result1 = isCommandAllowedByConfig("test --flag", config, {
        cwd,
        homeDir,
      });
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowedByConfig("test file.txt", config, {
        cwd,
        homeDir,
      });
      expect(result2.allowed).toBe(true);

      const result3 = isCommandAllowedByConfig("test --flag file.txt", config, {
        cwd,
        homeDir,
      });
      expect(result3.allowed).toBe(true);
    });
  });

  describe("pipeCommands argument matching", () => {
    it("should use pipeCommands when command is receiving pipe input", () => {
      const config: CommandPermissions = {
        commands: [
          ["cat", { type: "file" }],
          ["head", { type: "file" }], // Standalone: requires file
        ],
        pipeCommands: [
          ["head"], // Piped: no args required
        ],
      };

      // Piped command should use pipeCommands (no file required)
      const result = isCommandAllowedByConfig("cat file.txt | head", config, {
        cwd,
        homeDir,
      });
      expect(result.allowed).toBe(true);
    });

    it("should use commands when command is not receiving pipe input", () => {
      const config: CommandPermissions = {
        commands: [
          ["head", { type: "file" }], // Standalone: requires file
        ],
        pipeCommands: [
          ["head"], // Piped: no args required
        ],
      };

      // Standalone command should use commands (file required)
      const result1 = isCommandAllowedByConfig("head file.txt", config, {
        cwd,
        homeDir,
      });
      expect(result1.allowed).toBe(true);

      // Without file should fail
      const result2 = isCommandAllowedByConfig("head", config, {
        cwd,
        homeDir,
      });
      expect(result2.allowed).toBe(false);
    });

    it("should allow pipeCommands with flags", () => {
      const config: CommandPermissions = {
        commands: [
          ["cat", { type: "file" }],
          ["head", { type: "file" }],
        ],
        pipeCommands: [
          ["head"], // No args
          ["head", "-n", { type: "any" }], // Optional -n flag
        ],
      };

      const result1 = isCommandAllowedByConfig("cat file.txt | head", config, {
        cwd,
        homeDir,
      });
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowedByConfig(
        "cat file.txt | head -n 10",
        config,
        { cwd, homeDir },
      );
      expect(result2.allowed).toBe(true);
    });

    it("should reject when piped command args don't match pipeCommands patterns", () => {
      const config: CommandPermissions = {
        commands: [
          ["cat", { type: "file" }],
          ["head", { type: "file" }],
        ],
        pipeCommands: [
          ["head", "-n", { type: "any" }], // Only -n flag allowed when piped
        ],
      };

      // Empty args when piped should fail since pipeCommands requires -n
      const result = isCommandAllowedByConfig("cat file.txt | head", config, {
        cwd,
        homeDir,
      });
      expect(result.allowed).toBe(false);
    });

    it("should handle multi-stage pipelines", () => {
      const config: CommandPermissions = {
        commands: [
          ["cat", { type: "file" }],
          ["grep", { type: "any" }, { type: "file" }], // Standalone: pattern + file
          ["head", { type: "file" }], // Standalone: file required
        ],
        pipeCommands: [
          ["grep", { type: "any" }], // Piped: just pattern
          ["head"], // Piped: no args
          ["head", "-n", { type: "any" }], // Piped: -n flag
        ],
      };

      const result = isCommandAllowedByConfig(
        "cat file.txt | grep pattern | head -n 5",
        config,
        { cwd, homeDir },
      );
      expect(result.allowed).toBe(true);
    });

    it("should fall back to commands when pipeCommands doesn't match", () => {
      const config: CommandPermissions = {
        commands: [
          ["cat", { type: "file" }],
          ["wc", "-l"], // Same pattern for both piped and standalone
        ],
        pipeCommands: [],
      };

      // Should work standalone using commands
      const result1 = isCommandAllowedByConfig("wc -l", config, {
        cwd,
        homeDir,
      });
      expect(result1.allowed).toBe(true);

      // When piped, falls back to commands (which matches)
      const result2 = isCommandAllowedByConfig("cat file.txt | wc -l", config, {
        cwd,
        homeDir,
      });
      expect(result2.allowed).toBe(false); // pipeCommands is empty, so piped wc fails
    });

    it("should work with optional groups in pipeCommands", () => {
      const config: CommandPermissions = {
        commands: [
          ["cat", { type: "file" }],
          ["grep", { type: "any" }, { type: "file" }],
        ],
        pipeCommands: [
          [
            "grep",
            { type: "group", optional: true, args: ["-i"] },
            { type: "any" },
          ],
        ],
      };

      const result1 = isCommandAllowedByConfig(
        "cat file.txt | grep pattern",
        config,
        { cwd, homeDir },
      );
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowedByConfig(
        "cat file.txt | grep -i pattern",
        config,
        { cwd, homeDir },
      );
      expect(result2.allowed).toBe(true);
    });

    it("should not treat && chained commands as receiving pipe", () => {
      const config: CommandPermissions = {
        commands: [
          ["cat", { type: "file" }],
          ["head", { type: "file" }], // Standalone: requires file
        ],
        pipeCommands: [
          ["head"], // Piped: no args required
        ],
      };

      // && should not count as pipe, so head needs a file arg
      const result = isCommandAllowedByConfig("cat file.txt && head", config, {
        cwd,
        homeDir,
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe("checkCommandListPermissions", () => {
    it("should work with pre-parsed commands", () => {
      const config: CommandPermissions = {
        commands: [["ls"]],
        pipeCommands: [],
      };

      const parsed = parse("ls");
      const result = checkCommandListPermissions(parsed, config, {
        cwd,
        homeDir,
      });
      expect(result.allowed).toBe(true);
    });
  });
});
describe("isCommandAllowedByConfig with magenta temp files", () => {
  test("allows cat on magenta temp files", () => {
    const result = isCommandAllowedByConfig(
      "cat /tmp/magenta/threads/abc123/tools/tool_1/bashCommand.log",
      BUILTIN_COMMAND_PERMISSIONS,
      {
        cwd: "/home/user/project" as NvimCwd,
        homeDir: "/home/user" as HomeDir,
      },
    );
    expect(result.allowed).toBe(true);
  });

  test("allows head on magenta temp files", () => {
    const result = isCommandAllowedByConfig(
      "head -20 /tmp/magenta/threads/abc123/tools/tool_1/bashCommand.log",
      BUILTIN_COMMAND_PERMISSIONS,
      {
        cwd: "/home/user/project" as NvimCwd,
        homeDir: "/home/user" as HomeDir,
      },
    );
    expect(result.allowed).toBe(true);
  });

  test("allows tail on magenta temp files", () => {
    const result = isCommandAllowedByConfig(
      "tail -50 /tmp/magenta/threads/abc123/tools/tool_1/bashCommand.log",
      BUILTIN_COMMAND_PERMISSIONS,
      {
        cwd: "/home/user/project" as NvimCwd,
        homeDir: "/home/user" as HomeDir,
      },
    );
    expect(result.allowed).toBe(true);
  });

  test("disallows cat on other /tmp files", () => {
    const result = isCommandAllowedByConfig(
      "cat /tmp/other/file.txt",
      BUILTIN_COMMAND_PERMISSIONS,
      {
        cwd: "/home/user/project" as NvimCwd,
        homeDir: "/home/user" as HomeDir,
      },
    );
    expect(result.allowed).toBe(false);
  });

  test("allows grep on magenta temp files", () => {
    const result = isCommandAllowedByConfig(
      "grep error /tmp/magenta/threads/abc123/tools/tool_1/bashCommand.log",
      BUILTIN_COMMAND_PERMISSIONS,
      {
        cwd: "/home/user/project" as NvimCwd,
        homeDir: "/home/user" as HomeDir,
      },
    );
    expect(result.allowed).toBe(true);
  });
});

describe("filePermissions with tilde expansion", () => {
  test("allows command using tilde path when filePermissions uses tilde", () => {
    const config: CommandPermissions = {
      commands: [["ls", { type: "readFile" }]],
      pipeCommands: [],
    };

    // filePermissions uses ~/projects, command uses ~/projects
    const result = isCommandAllowedByConfig("ls ~/projects", config, {
      cwd: "/some/project" as NvimCwd,
      homeDir: "/home/user" as HomeDir,
      filePermissions: [{ path: "~/projects", read: true }],
    });
    expect(result.allowed).toBe(true);
  });

  test("allows command using absolute path when filePermissions uses tilde", () => {
    const config: CommandPermissions = {
      commands: [["cat", { type: "readFile" }]],
      pipeCommands: [],
    };

    // filePermissions uses ~/Documents, command uses absolute path
    const result = isCommandAllowedByConfig(
      "cat /home/user/Documents/file.txt",
      config,
      {
        cwd: "/some/project" as NvimCwd,
        homeDir: "/home/user" as HomeDir,
        filePermissions: [{ path: "~/Documents", read: true }],
      },
    );
    expect(result.allowed).toBe(true);
  });

  test("allows command using tilde path when filePermissions uses absolute path", () => {
    const config: CommandPermissions = {
      commands: [["cat", { type: "readFile" }]],
      pipeCommands: [],
    };

    // filePermissions uses absolute path, command uses tilde
    const result = isCommandAllowedByConfig(
      "cat ~/Documents/file.txt",
      config,
      {
        cwd: "/some/project" as NvimCwd,
        homeDir: "/home/user" as HomeDir,
        filePermissions: [{ path: "/home/user/Documents", read: true }],
      },
    );
    expect(result.allowed).toBe(true);
  });

  test("rejects command when path is not permitted", () => {
    const config: CommandPermissions = {
      commands: [["cat", { type: "readFile" }]],
      pipeCommands: [],
    };

    // filePermissions only permits ~/Documents, but command accesses ~/other
    const result = isCommandAllowedByConfig("cat ~/other/file.txt", config, {
      cwd: "/some/project" as NvimCwd,
      homeDir: "/home/user" as HomeDir,
      filePermissions: [{ path: "~/Documents", read: true }],
    });
    expect(result.allowed).toBe(false);
  });

  test("allows write command when filePermissions grants write with tilde", () => {
    const config: CommandPermissions = {
      commands: [["touch", { type: "writeFile" }]],
      pipeCommands: [],
    };

    const result = isCommandAllowedByConfig("touch ~/output/file.txt", config, {
      cwd: "/some/project" as NvimCwd,
      homeDir: "/home/user" as HomeDir,
      filePermissions: [{ path: "~/output", write: true }],
    });
    expect(result.allowed).toBe(true);
  });

  test("rejects write command when filePermissions only grants read with tilde", () => {
    const config: CommandPermissions = {
      commands: [["touch", { type: "writeFile" }]],
      pipeCommands: [],
    };

    const result = isCommandAllowedByConfig("touch ~/output/file.txt", config, {
      cwd: "/some/project" as NvimCwd,
      homeDir: "/home/user" as HomeDir,
      filePermissions: [{ path: "~/output", read: true }], // only read, not write
    });
    expect(result.allowed).toBe(false);
  });
});

describe("file redirect permissions", () => {
  let testDir: string;
  let cwd: NvimCwd;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-redirect-test-"));
    cwd = testDir as NvimCwd;
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("should allow redirect to /dev/null", () => {
    const result = isCommandAllowedByConfig(
      "ls 2>/dev/null",
      BUILTIN_COMMAND_PERMISSIONS,
      { cwd, homeDir },
    );
    expect(result.allowed).toBe(true);
  });

  it("should allow command with semicolons and /dev/null redirects", () => {
    const result = isCommandAllowedByConfig(
      'ls core/tools/specs/ 2>/dev/null; echo "---"; ls core/edl/ 2>/dev/null',
      BUILTIN_COMMAND_PERMISSIONS,
      { cwd, homeDir },
    );
    expect(result.allowed).toBe(true);
  });

  it("should deny redirect to arbitrary file", () => {
    const result = isCommandAllowedByConfig(
      "ls > output.txt",
      BUILTIN_COMMAND_PERMISSIONS,
      { cwd, homeDir },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("file redirection");
  });

  it("should deny redirect to arbitrary file with fd", () => {
    const result = isCommandAllowedByConfig(
      "cmd 2> errors.log",
      BUILTIN_COMMAND_PERMISSIONS,
      { cwd, homeDir },
    );
    expect(result.allowed).toBe(false);
  });

  it("should allow fd-to-fd redirects", () => {
    const result = isCommandAllowedByConfig(
      "ls 2>&1",
      BUILTIN_COMMAND_PERMISSIONS,
      { cwd, homeDir },
    );
    expect(result.allowed).toBe(true);
  });
});
