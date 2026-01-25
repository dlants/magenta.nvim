# Context

The goal is to persist bash command output to disk and abbreviate the tool result to save tokens while still giving the agent access to full output when needed.

Currently:

- Output is stored in-memory as `OutputLine[]` array
- Preview shows last 10 lines
- Tool result sends last ~10k tokens of output
- No persistence to disk

Relevant files and entities:

- `node/tools/bashCommand.ts`: The `BashCommandTool` class that executes bash commands. Contains `executeCommand()`, `getToolResult()`, output handling logic.
- `node/chat/chat.ts`: The `Chat` class that manages threads. Contains `createThreadWithContext()` and thread creation logic.
- `node/chat/types.ts`: Defines `ThreadId` as a branded number type.
- `node/tools/toolManager.ts`: The `ToolManager` class that instantiates tools and passes context to them.
- `node/tools/types.ts`: Defines `ToolRequestId` as a branded string (comes from LLM provider).

Key observations:

- `ThreadId` is currently a branded number. Will change to branded string using UUIDv7 (timestamp-prefixed, lexically sortable).
- `ToolRequestId` is a string provided by the LLM provider - suitable for directory naming.
- `ToolManager` has access to `threadId` but doesn't currently pass it to `BashCommandTool`.

# Implementation

- [x] Change `ThreadId` to use UUIDv7
  - [x] Install `uuid` package: `npm install uuid` and `npm install -D @types/uuid`
  - [x] Change `ThreadId` type in `node/chat/types.ts` from `number & { __threadId: true }` to `string & { __threadId: true }`
  - [x] Update `node/chat/chat.ts`: replace `Counter` usage with `v7()` from `uuid` package for thread ID generation
  - [x] Fix all references that assume `ThreadId` is a number (e.g., `Number(threadId)`, `toString()` calls)
  - [x] Pass `threadId` through `ToolManager` context to `BashCommandTool`
  - [x] Check for type errors and iterate until they pass

- [x] Create directory structure and log file
  - [x] Add `fs` imports to `bashCommand.ts`
  - [x] In `BashCommandTool` constructor (when command is approved), create directory `/tmp/magenta/threads/<threadId>/tools/<requestId>/`
  - [x] Create and open write stream to `bashCommand.log`
  - [x] Write the command as first line: `$ <command>`
  - [x] Check for type errors and iterate until they pass

- [x] Stream output to log file
  - [x] In `executeCommand()`, write each stdout/stderr line to the log file with prefix (`stdout: ` or `stderr: `)
  - [x] Keep the existing in-memory `output` array for preview display
  - [x] Close the write stream on exit/error
  - [x] Check for type errors and iterate until they pass

- [x] Abbreviate tool result output
  - [x] Modify `getToolResult()` for the "done" state:
    - [x] Count total lines in output
    - [x] If total lines <= 30, return all lines as before
    - [x] If total lines > 30, return: first 10 lines + `\n... (N lines omitted) ...\n` + last 20 lines
    - [x] Append: `\nFull output (M lines): /tmp/magenta/threads/<threadId>/tools/<requestId>/bashCommand.log`
  - [x] Check for type errors and iterate until they pass

- [x] Update tool description and system reminders
  - [x] Update `BASE_DESCRIPTION` in `node/tools/bashCommand.ts` to mention that long output will be abbreviated (first 10 + last 20 lines) with full output saved to a log file that can be read with get_file
  - [x] Added guidance to tool description about not needing grep/head/tail to limit output (system-reminders.ts is for skills only)
  - [x] Check for type errors and iterate until they pass

- [x] Write tests
  - [x] Add test for log file creation and content format
  - [x] Add test for output abbreviation (>30 lines)
  - [x] Add test for full output (<=30 lines)
  - [x] Add test for token-based trimming with very long lines
  - [x] Iterate until tests pass

- [x] Cleanup
  - [x] Ensure write stream is closed on `abort()`
  - [x] Ensure write stream is closed on `terminate()` (via `closeLogStream()` call in `abort()`)
