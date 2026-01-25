# Context

The goal is to allow the agent to read files from the `/tmp/magenta/threads/` directory using `get_file`. This enables the agent to access full bash command output logs when the abbreviated tool result isn't sufficient.

Currently:

- `canReadFile` in `node/tools/permissions.ts` checks if a file is auto-allowed based on:
  1. Skills directory membership
  2. Auto-allow glob patterns
  3. Being inside cwd (files outside require confirmation)
  4. Not being hidden (dotfiles require confirmation)
  5. Not being gitignored
- Files in `/tmp/magenta/threads/` are outside cwd, so they require user confirmation

Relevant files and entities:

- `node/tools/permissions.ts`: Contains `canReadFile()` function that determines if a file read requires user approval
- `node/tools/getFile.ts`: Uses `canReadFile()` in `initReadFile()` to decide whether to auto-approve or request user approval
- `node/tools/bashCommand.ts`: Creates log files at `/tmp/magenta/threads/<threadId>/tools/<requestId>/bashCommand.log`

Key observations:

- The temp directory path `/tmp/magenta/threads/` is hardcoded in `bashCommand.ts`
- We should define this as a constant and share it
- Files in this directory should be auto-approved for reading (they're our own output logs)

# Implementation

- [x] Define shared constant for temp directory base path
  - [x] Add `MAGENTA_TEMP_DIR = "/tmp/magenta"` constant to `node/utils/files.ts`
  - [x] Update `bashCommand.ts` to use this constant instead of hardcoded path
  - [x] Check for type errors and iterate until they pass

- [x] Update `canReadFile` to auto-allow magenta temp files
  - [x] Add helper function `isFileInMagentaTempDirectory(absFilePath: AbsFilePath): boolean` in `node/tools/permissions.ts`
  - [x] Add check at the beginning of `canReadFile`: if file is in magenta temp dir, return `true`
  - [x] Check for type errors and iterate until they pass

- [x] Update bash command `isPathSafe` to allow magenta temp files
  - [x] Import `MAGENTA_TEMP_DIR` from `node/utils/files.ts` in `node/tools/bash-parser/permissions.ts`
  - [x] Add check in `isPathSafe`: if absPath starts with `MAGENTA_TEMP_DIR`, return `{ safe: true }`
  - [x] Check for type errors and iterate until they pass

- [x] Write tests
  - [x] Add test that `canReadFile` returns `true` for files in `/tmp/magenta/threads/` directory
  - [x] Add test that `canReadFile` still requires confirmation for other `/tmp/` files
  - [x] Add test that bash commands with magenta temp file paths are allowed (e.g., `cat /tmp/magenta/threads/.../file`)
  - [x] Iterate until tests pass
