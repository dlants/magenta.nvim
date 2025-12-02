import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import ignore from "ignore";
import type { NvimCwd } from "../../utils/files.ts";
import {
  isCommandAllowedByConfig,
  checkCommandListPermissions,
  type CommandPermissions,
} from "./permissions.ts";
import { parse } from "./parser.ts";
import type { Gitignore } from "../util.ts";

// Create an empty gitignore for tests
function createEmptyGitignore(): Gitignore {
  return ignore();
}

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
        ls: { args: [[]] },
      };

      const result = isCommandAllowedByConfig("ls", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(true);
    });

    it("should reject unconfigured command", () => {
      const config: CommandPermissions = {
        ls: { args: [[]] },
      };

      const result = isCommandAllowedByConfig("rm -rf /", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("rm");
      expect(result.reason).toContain("not in the allowlist");
    });

    it("should allow command with exact literal args", () => {
      const config: CommandPermissions = {
        npx: {
          subCommands: {
            tsc: {
              args: [["--noEmit"], ["--noEmit", "--watch"]],
            },
          },
        },
      };

      const result1 = isCommandAllowedByConfig("npx tsc --noEmit", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowedByConfig(
        "npx tsc --noEmit --watch",
        config,
        { cwd, gitignore: createEmptyGitignore() },
      );
      expect(result2.allowed).toBe(true);
    });

    it("should reject command with wrong arg order", () => {
      const config: CommandPermissions = {
        npx: {
          subCommands: {
            tsc: {
              args: [["--noEmit", "--watch"]],
            },
          },
        },
      };

      const result = isCommandAllowedByConfig(
        "npx tsc --watch --noEmit",
        config,
        {
          cwd,
          gitignore: createEmptyGitignore(),
        },
      );
      expect(result.allowed).toBe(false);
    });

    it("should reject command with extra args", () => {
      const config: CommandPermissions = {
        npx: {
          subCommands: {
            tsc: {
              args: [["--noEmit"]],
            },
          },
        },
      };

      const result = isCommandAllowedByConfig(
        "npx tsc --noEmit --extra",
        config,
        {
          cwd,
          gitignore: createEmptyGitignore(),
        },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("extra");
    });
  });

  describe("file argument matching", () => {
    it("should allow command with safe file path", () => {
      const config: CommandPermissions = {
        cat: {
          args: [[{ file: true }]],
        },
      };

      const result = isCommandAllowedByConfig("cat file.txt", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(true);
    });

    it("should allow command with nested file path", () => {
      const config: CommandPermissions = {
        cat: {
          args: [[{ file: true }]],
        },
      };

      const result = isCommandAllowedByConfig("cat subdir/nested.txt", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(true);
    });

    it("should reject file outside cwd", () => {
      const config: CommandPermissions = {
        cat: {
          args: [[{ file: true }]],
        },
      };

      const result = isCommandAllowedByConfig("cat /etc/passwd", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("outside project directory");
    });

    it("should reject file in hidden directory", () => {
      const config: CommandPermissions = {
        cat: {
          args: [[{ file: true }]],
        },
      };

      const result = isCommandAllowedByConfig(
        "cat .hidden/secret.txt",
        config,
        {
          cwd,
          gitignore: createEmptyGitignore(),
        },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("hidden");
    });

    it("should reject file traversing outside cwd", () => {
      const config: CommandPermissions = {
        cat: {
          args: [[{ file: true }]],
        },
      };

      const result = isCommandAllowedByConfig(
        "cat ../../../etc/passwd",
        config,
        { cwd, gitignore: createEmptyGitignore() },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("outside project directory");
    });
  });

  describe("any (wildcard) argument matching", () => {
    it("should allow command with any single argument", () => {
      const config: CommandPermissions = {
        head: {
          args: [["-n", { any: true }, { file: true }]],
        },
      };

      const result = isCommandAllowedByConfig("head -n 10 file.txt", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(true);
    });

    it("should allow any value for wildcard argument", () => {
      const config: CommandPermissions = {
        head: {
          args: [["-n", { any: true }, { file: true }]],
        },
      };

      const result1 = isCommandAllowedByConfig("head -n 100 file.txt", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowedByConfig("head -n abc file.txt", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result2.allowed).toBe(true);
    });

    it("should reject when wildcard argument is missing", () => {
      const config: CommandPermissions = {
        head: {
          args: [["-n", { any: true }, { file: true }]],
        },
      };

      const result = isCommandAllowedByConfig("head -n file.txt", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      // This should fail because -n expects a value, so file.txt would be the value
      // and then there's no file argument
      expect(result.allowed).toBe(false);
    });

    it("should work with just flag and wildcard (no file)", () => {
      const config: CommandPermissions = {
        test: {
          args: [["-n", { any: true }]],
        },
      };

      const result = isCommandAllowedByConfig("test -n 42", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(true);
    });

    it("should reject extra arguments after wildcard", () => {
      const config: CommandPermissions = {
        test: {
          args: [["-n", { any: true }]],
        },
      };

      const result = isCommandAllowedByConfig("test -n 42 extra", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("extra");
    });
  });

  describe("pattern argument matching", () => {
    it("should allow argument matching regex pattern", () => {
      const config: CommandPermissions = {
        head: {
          args: [[{ pattern: "-[0-9]+" }]],
        },
      };

      const result = isCommandAllowedByConfig("head -50", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(true);
    });

    it("should reject argument not matching pattern", () => {
      const config: CommandPermissions = {
        head: {
          args: [[{ pattern: "-[0-9]+" }]],
        },
      };

      const result = isCommandAllowedByConfig("head -abc", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("does not match pattern");
    });

    it("should match full argument with pattern (anchored)", () => {
      const config: CommandPermissions = {
        head: {
          args: [[{ pattern: "-[0-9]+" }]],
        },
      };

      // -50abc should not match because pattern is anchored
      const result = isCommandAllowedByConfig("head -50abc", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(false);
    });

    it("should work with pattern followed by file", () => {
      const config: CommandPermissions = {
        head: {
          args: [[{ pattern: "-[0-9]+" }, { file: true }]],
        },
      };

      const result = isCommandAllowedByConfig("head -10 file.txt", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(true);
    });

    it("should support multiple arg patterns including pattern", () => {
      const config: CommandPermissions = {
        tail: {
          args: [["-n", { any: true }], [{ pattern: "-[0-9]+" }]],
        },
      };

      const result1 = isCommandAllowedByConfig("tail -n 5", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowedByConfig("tail -5", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result2.allowed).toBe(true);
    });
  });

  describe("restFiles argument matching", () => {
    it("should allow multiple file arguments with restFiles", () => {
      const config: CommandPermissions = {
        npx: {
          subCommands: {
            vitest: {
              subCommands: {
                run: {
                  args: [[{ restFiles: true }]],
                },
              },
            },
          },
        },
      };

      const result = isCommandAllowedByConfig(
        "npx vitest run file.txt subdir/nested.txt",
        config,
        { cwd, gitignore: createEmptyGitignore() },
      );
      expect(result.allowed).toBe(true);
    });

    it("should allow zero files with restFiles", () => {
      const config: CommandPermissions = {
        npx: {
          subCommands: {
            vitest: {
              subCommands: {
                run: {
                  args: [[{ restFiles: true }]],
                },
              },
            },
          },
        },
      };

      const result = isCommandAllowedByConfig("npx vitest run", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(true);
    });

    it("should reject if any file in restFiles is unsafe", () => {
      const config: CommandPermissions = {
        cat: {
          args: [[{ restFiles: true }]],
        },
      };

      const result = isCommandAllowedByConfig(
        "cat file.txt /etc/passwd",
        config,
        { cwd, gitignore: createEmptyGitignore() },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("outside project directory");
    });
  });

  describe("command chaining with cwd tracking", () => {
    it("should track cwd through cd commands", () => {
      const config: CommandPermissions = {
        cat: {
          args: [[{ file: true }]],
        },
      };

      // cd to subdir then cat nested.txt (which is now just nested.txt relative to subdir)
      const result = isCommandAllowedByConfig(
        "cd subdir && cat nested.txt",
        config,
        { cwd, gitignore: createEmptyGitignore() },
      );
      expect(result.allowed).toBe(true);
    });

    it("should reject when cd goes outside project", () => {
      const config: CommandPermissions = {
        cat: {
          args: [[{ file: true }]],
        },
      };

      const result = isCommandAllowedByConfig("cd .. && cat file.txt", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("outside project directory");
    });

    it("should handle multiple commands in sequence", () => {
      const config: CommandPermissions = {
        echo: {
          args: [[{ restFiles: true }]],
        },
        cat: {
          args: [[{ file: true }]],
        },
      };

      const result = isCommandAllowedByConfig(
        "echo hello && cat file.txt",
        config,
        { cwd, gitignore: createEmptyGitignore() },
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("skills script execution", () => {
    it("should allow direct script execution from skills directory", () => {
      const config: CommandPermissions = {};
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      const result = isCommandAllowedByConfig(
        "./.magenta/skills/test-skill/script.sh",
        config,
        { cwd, skillsPaths, gitignore: createEmptyGitignore() },
      );
      expect(result.allowed).toBe(true);
    });

    it("should allow bash script.sh from skills directory", () => {
      const config: CommandPermissions = {};
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      const result = isCommandAllowedByConfig(
        "bash .magenta/skills/test-skill/script.sh",
        config,
        { cwd, skillsPaths, gitignore: createEmptyGitignore() },
      );
      expect(result.allowed).toBe(true);
    });

    it("should allow npx tsx script.ts from skills directory", () => {
      const config: CommandPermissions = {};
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      const result = isCommandAllowedByConfig(
        "npx tsx .magenta/skills/test-skill/script.ts",
        config,
        { cwd, skillsPaths, gitignore: createEmptyGitignore() },
      );
      expect(result.allowed).toBe(true);
    });

    it("should allow cd to skills dir && ./script.sh", () => {
      const config: CommandPermissions = {};
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      const result = isCommandAllowedByConfig(
        "cd .magenta/skills/test-skill && ./script.sh",
        config,
        { cwd, skillsPaths, gitignore: createEmptyGitignore() },
      );
      expect(result.allowed).toBe(true);
    });

    it("should not allow non-skills script execution", () => {
      const config: CommandPermissions = {};
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      // Create a non-skills script
      fs.writeFileSync(
        path.join(testDir, "malicious.sh"),
        "#!/bin/bash\nrm -rf /",
      );

      const result = isCommandAllowedByConfig("./malicious.sh", config, {
        cwd,
        skillsPaths,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe("parse errors", () => {
    it("should reject commands with unsupported features", () => {
      const config: CommandPermissions = {
        echo: { args: [[{ restFiles: true }]] },
      };

      const result = isCommandAllowedByConfig("echo $(whoami)", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("failed to parse");
    });

    it("should reject commands with variable expansion", () => {
      const config: CommandPermissions = {
        echo: { args: [[{ restFiles: true }]] },
      };

      const result = isCommandAllowedByConfig("echo $HOME", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("failed to parse");
    });
  });

  describe("allowAll configuration", () => {
    it("should allow command with any arguments when allowAll is set", () => {
      const config: CommandPermissions = {
        echo: { allowAll: true },
      };

      const result1 = isCommandAllowedByConfig("echo hello world", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowedByConfig(
        "echo --flag -x arg1 arg2",
        config,
        { cwd, gitignore: createEmptyGitignore() },
      );
      expect(result2.allowed).toBe(true);

      const result3 = isCommandAllowedByConfig("echo", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result3.allowed).toBe(true);
    });

    it("should allow subcommand with any arguments when allowAll is set", () => {
      const config: CommandPermissions = {
        npm: {
          subCommands: {
            run: { allowAll: true },
          },
        },
      };

      const result = isCommandAllowedByConfig(
        "npm run test --coverage --watch",
        config,
        { cwd, gitignore: createEmptyGitignore() },
      );
      expect(result.allowed).toBe(true);
    });

    it("should still require correct subcommand even with allowAll on nested spec", () => {
      const config: CommandPermissions = {
        npm: {
          subCommands: {
            run: { allowAll: true },
          },
        },
      };

      const result = isCommandAllowedByConfig("npm install lodash", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe("chaining security", () => {
    it("should reject chaining allowAll command with non-allowlisted command", () => {
      const config: CommandPermissions = {
        echo: { allowAll: true },
      };

      const result = isCommandAllowedByConfig(
        "echo hello && rm -rf /",
        config,
        {
          cwd,
          gitignore: createEmptyGitignore(),
        },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("rm");
      expect(result.reason).toContain("not in the allowlist");
    });

    it("should reject chaining skills script with non-allowlisted command", () => {
      const config: CommandPermissions = {};
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      const result = isCommandAllowedByConfig(
        "./.magenta/skills/test-skill/script.sh && rm -rf /",
        config,
        { cwd, skillsPaths, gitignore: createEmptyGitignore() },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("rm");
      expect(result.reason).toContain("not in the allowlist");
    });

    it("should reject piping allowAll command to non-allowlisted command", () => {
      const config: CommandPermissions = {
        echo: { allowAll: true },
      };

      const result = isCommandAllowedByConfig("echo hello | xargs rm", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("xargs");
    });

    it("should reject OR-chaining allowAll command with non-allowlisted command", () => {
      const config: CommandPermissions = {
        echo: { allowAll: true },
      };

      const result = isCommandAllowedByConfig(
        "echo hello || malicious_cmd",
        config,
        { cwd, gitignore: createEmptyGitignore() },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("malicious_cmd");
    });

    it("should allow chaining multiple allowlisted commands", () => {
      const config: CommandPermissions = {
        echo: { allowAll: true },
        ls: { args: [[]] },
      };

      const result = isCommandAllowedByConfig("echo hello && ls", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(true);
    });

    it("should allow chaining skills script with allowlisted command", () => {
      const config: CommandPermissions = {
        echo: { allowAll: true },
      };
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      const result = isCommandAllowedByConfig(
        "./.magenta/skills/test-skill/script.sh && echo done",
        config,
        { cwd, skillsPaths, gitignore: createEmptyGitignore() },
      );
      expect(result.allowed).toBe(true);
    });

    it("should allow chaining multiple skills scripts", () => {
      const config: CommandPermissions = {};
      const skillsPaths = [path.join(testDir, ".magenta", "skills")];

      // Create a second script
      fs.writeFileSync(
        path.join(skillsDir, "script2.sh"),
        "#!/bin/bash\necho world",
      );

      const result = isCommandAllowedByConfig(
        "./.magenta/skills/test-skill/script.sh && ./.magenta/skills/test-skill/script2.sh",
        config,
        { cwd, skillsPaths, gitignore: createEmptyGitignore() },
      );
      expect(result.allowed).toBe(true);
    });
  });

  describe("complex configurations", () => {
    it("should handle nested subcommands with file args", () => {
      const config: CommandPermissions = {
        git: {
          subCommands: {
            add: {
              args: [[{ restFiles: true }]],
            },
          },
        },
      };

      // Should allow adding files in the project
      const result1 = isCommandAllowedByConfig("git add file.txt", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result1.allowed).toBe(true);

      // Should reject adding files outside the project
      const result2 = isCommandAllowedByConfig("git add /etc/passwd", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result2.allowed).toBe(false);
      expect(result2.reason).toContain("outside project directory");
    });

    it("should handle deeply nested subcommands", () => {
      const config: CommandPermissions = {
        git: {
          subCommands: {
            remote: {
              subCommands: {
                add: {
                  args: [["origin", "url"]],
                },
              },
            },
          },
        },
      };

      const result = isCommandAllowedByConfig(
        "git remote add origin url",
        config,
        { cwd, gitignore: createEmptyGitignore() },
      );
      expect(result.allowed).toBe(true);
    });

    it("should match first valid pattern", () => {
      const config: CommandPermissions = {
        test: {
          args: [["--flag"], [{ file: true }], ["--flag", { file: true }]],
        },
      };

      const result1 = isCommandAllowedByConfig("test --flag", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result1.allowed).toBe(true);

      const result2 = isCommandAllowedByConfig("test file.txt", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result2.allowed).toBe(true);

      const result3 = isCommandAllowedByConfig("test --flag file.txt", config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result3.allowed).toBe(true);
    });
  });

  describe("checkCommandListPermissions", () => {
    it("should work with pre-parsed commands", () => {
      const config: CommandPermissions = {
        ls: { args: [[]] },
      };

      const parsed = parse("ls");
      const result = checkCommandListPermissions(parsed, config, {
        cwd,
        gitignore: createEmptyGitignore(),
      });
      expect(result.allowed).toBe(true);
    });
  });
});
