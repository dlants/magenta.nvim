I want to implement a parsing-based permissions structure for which bash commands can execute.

Use the technique described in this blog post: https://engineering.desmos.com/articles/pratt-parser/

here's sample code that should serve as a starter point: https://github.com/desmosinc/pratt-parser-blog-code

During parsing, we don't need to understand the full bash command. We mostly need to understand the following:

- how the command decomposes into sub-commands (&&, ||, pipes, semicolons)
- common console redirections, like 2>&1
- for each command, what was the invoked script and the list of arguments provided

The point of this is to support a more advanced options for automatically allowed bash commands. I want this to be safe and predictable from the user's pov - to make it easy to understand exactly what will be allowed to run, and to stay on the safe side to make sure no hacky workarounds to execute arbitrary commands, or allow access to unexpected files.

We will not handle more advanced bash features, like command expansions and such. If we encounter an unusual or unexpected pattern, we should just bail and not allow the command to run (and fall back to asking the user for permission to run it).

The options are currently specified in `node/options.ts`, in the `commandAllowlist` option. I want to replace this with the following structure:

```
{
    npx: {
        subCommands: {
            tsc: {
                args: [['--noEmit'], ['--noEmit', '--watch']]
            },
            vitest: {
                subCommands: {
                    run: {
                        args: [[{restFiles: true}]]
                    }
                }
            }
        }
    },

    cat: {
        args: [[{file: true}]]
    }
}
```

This is pretty self-explanatory. This configuration would allow `npx tsc --noEmit`, `npx vitest run ` followed by whatever, and `cat file`, if the file is in the cwd for the project, and is not in a hidden subdirectory.

Since the order of arguments has meaning, and the meaning depends on the actual command that is run, the `arguments` array is order specific. So in this example, `npx tsc --watch --noEmit` would not be allowed.

To track file location, we should keep track of the cwd of the command. So when analyzing something like `cd .. && cat dir/file.txt` should keep track of the cwd during the cd .. command, then resolve dir/file.txt relative to that, and ensure that it's a non-hidden project file.

We should also apply this to the logic around whether we allow invoking skill scripts. We should accept either a direct invocation through one of the forms (as a script, or via runners like npx). We should accept any arguments. We should also accept `cd <scriptdir> && ./script` forms.

## Current Implementation Analysis

### Command Allowlist

- **Type Definition**: `node/options.ts:56` - `CommandAllowlist = string[]` (array of regex patterns)
- **Permission Logic**: `node/tools/bashCommand.ts:117-193` - `isCommandAllowed()` function
  - Checks `rememberedCommands` set first
  - Strips `cd <cwd> &&` prefix before checking
  - Checks if command executes a skills directory script via `isSkillsScript()`
  - Tests command against regex patterns in `allowlist`
- **Skills Script Detection**: `node/tools/bashCommand.ts:84-115` - `isSkillsScript()` / `extractScriptPath()` / `isWithinSkillsDir()`
  - Handles: `bash script.sh`, `./script.sh`, `python script.py`, `node script.js`, `npx tsx script.ts`
- **Tests**: `node/tools/bashCommand.spec.ts`

### File Access Permissions

- **Core Logic**: `node/tools/permissions.ts` - `canReadFile()` and `canWriteFile()`
- **Checks performed** (in order):
  1. Skills directory files are auto-approved for reading
  2. Auto-allow globs (`getFileAutoAllowGlobs` option)
  3. Files outside cwd require confirmation
  4. Hidden files (path parts starting with `.`) require confirmation
  5. Gitignored files require confirmation
- **Helper Functions**:
  - `isFileInSkillsDirectory()` - checks if file is in any skills path
  - `isFileAutoAllowed()` - checks against glob patterns
  - `readGitignore()` in `node/tools/util.ts`
- **Path Utilities**: `node/utils/files.ts`
  - `resolveFilePath()` - resolves path relative to cwd
  - `relativePath()` - gets path relative to cwd
  - Branded types: `AbsFilePath`, `RelFilePath`, `UnresolvedFilePath`, `NvimCwd`

## Implementation Plan

### Phase 1: Lexer

- [x] Create `node/tools/bash-parser/lexer.ts`
- [x] Define token types:
  - `word` - unquoted text, single-quoted, or double-quoted (resolved to final string value)
  - `operator` - `&&`, `||`, `|`, `;`
  - `redirect` - `>`, `>>`, `<`, `2>&1`, etc.
- [x] Handle escape sequences:
  - Backslash escapes in unquoted context: `my\ file.txt` → `my file.txt`
  - Backslash escapes in double quotes: `"my \"file\".txt"` → `my "file".txt`
  - No escapes in single quotes (literal content)
- [x] Handle quote concatenation: `"foo"'bar'baz` → single word token `foobarbaz`
- [x] Throw immediately on unsupported features:
  - Command substitution: `$(`, backticks
  - Variable expansion: `$var`, `${`
  - Process substitution: `<(`, `>(`
  - Subshells/groups: `(`, `{`
  - Arithmetic: `$((`
- [x] Create `node/tools/bash-parser/lexer.spec.ts`

### Phase 2: Parser (Pratt-style)

- [x] Create `node/tools/bash-parser/parser.ts`
- [x] Define AST node types:

  ```typescript
  type ParsedCommand = {
    executable: string;
    args: string[];
  };

  type ParsedCommandList = {
    commands: ParsedCommand[];
  };
  ```

- [x] Implement Pratt parser following https://engineering.desmos.com/articles/pratt-parser/
- [x] Handle command separators: `&&`, `||`, `;`, `|` (all flatten to a list of commands)
- [x] Allow fd redirections: `2>&1`, `1>&2`, etc. (strip from command, ignore)
- [x] Throw error on file redirections (`>`, `>>`, `<`)
- [x] Create `node/tools/bash-parser/parser.spec.ts`

### Phase 3: Permission Checker

- [x] Create `node/tools/bash-parser/permissions.ts`
- [x] Define new config type (replacing `CommandAllowlist`):

  ```typescript
  type ArgSpec =
    | string // Exact literal argument
    | { file: true } // Single file path argument
    | { restFiles: true }; // Zero or more file paths (must be last)

  type CommandSpec = {
    subCommands?: Record<string, CommandSpec>;
    args?: ArgSpec[][]; // Array of allowed arg patterns
    allowAll?: true; // Allow any arguments
  };

  type CommandPermissions = Record<string, CommandSpec>;
  ```

- [x] Implement permission checking with cwd tracking:
  - Track cwd changes from `cd` commands in sequences
  - Validate file arguments against project boundaries (reuse `canReadFile` logic from `node/tools/permissions.ts`)
  - Check for hidden directories in file paths
- [x] Handle skills script execution:
  - Direct invocation: `./path/to/script.sh`
  - Via runners: `bash script.sh`, `npx tsx script.ts`, etc.
  - `cd <scriptdir> && ./script` forms
- [x] Implement `allowAll` option for commands/subcommands that accept any arguments
- [x] Ensure chaining security: `allowAll` and skills scripts can only chain with other allowlisted commands
- [x] Create `node/tools/bash-parser/permissions.spec.ts`

### Phase 4: Integration

- [x] Update `node/options.ts`:
  - Add new `CommandPermissions` type as `commandConfig` option
  - Keep existing `commandAllowlist` for backwards compatibility
  - Logic: use `commandConfig` if present, otherwise fall back to regex allowlist
  - Update `parseOptions()` to validate new structure
- [x] Update `node/tools/bashCommand.ts`:
  - Added `checkCommandPermissions()` function that decides which system to use
  - Keep existing `isCommandAllowed()` for regex-based checking
  - Integrated `isCommandAllowedByConfig()` from bash-parser
  - Keep `rememberedCommands` logic (applies to both systems)
  - Added new `checking-permissions` state for async permission checks
- [x] Existing tests in `node/tools/bashCommand.spec.ts` pass (30 tests)
- [x] Existing tests in `node/tools/bash-parser/permissions.spec.ts` pass (37 tests)
- [x] Add integration tests with realistic command patterns using new `commandConfig` (13 new tests)
