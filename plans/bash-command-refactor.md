# context

The goal is to refactor `BashCommandTool` so that command execution and permission checking are abstracted behind an interface, similar to how `FileIO` + `PermissionCheckingFileIO` work for `GetFileTool` and `EdlTool`.

Currently, `BashCommandTool` does three things itself:

1. **Permission checking** - calls `checkCommandPermissions()` in the constructor, manages "pending-user-action" state and the YES/NO/ALWAYS UI inline.
2. **Command execution** - spawns a child process, collects stdout/stderr, handles timeouts, termination.
3. **Output formatting & rendering** - formats output for the agent, manages log files, renders views.

The `FileIO` pattern separates these concerns:

- A core interface (`FileIO`) defines the operations (read, write, etc.)
- A base implementation (`FsFileIO` / `BufferAwareFileIO`) does the actual I/O.
- A decorator (`PermissionCheckingFileIO`) wraps the base, intercepts calls, prompts the user for approval via a promise-based blocking pattern, and has a `view()` method for the approval UI.
- The `Thread` class assembles the layers and passes the composed `FileIO` to tools via `CreateToolContext`.

We want to replicate this pattern for bash commands. Both `FileIO` and this new `Shell` are "capabilities" — abstractions over system resources that the agent can use, gated by permissions and swappable for testing.

## Relevant files and entities

- `node/edl/file-io.ts`: `FileIO` interface — the pattern to follow
- `node/tools/permission-file-io.ts`: `PermissionCheckingFileIO` — demonstrates the decorator + promise-based permission blocking pattern and `view()` for approval UI
- `node/tools/buffer-file-io.ts`: `BufferAwareFileIO` — the inner implementation
- `node/tools/bashCommand.ts`: `BashCommandTool` — the tool to refactor. Currently owns execution, permissions, log management, output formatting, and rendering
- `node/tools/bash-parser/permissions.ts`: `isCommandAllowedByConfig()` — parser-based permission checking
- `node/tools/create-tool.ts`: `createTool()` + `CreateToolContext` — where tools are instantiated and context is assembled
- `node/chat/thread.ts`: `Thread` constructor (lines ~260-280) — where `FileIO` layers are assembled; we need analogous assembly for the command executor. Also lines ~960-980 where `rememberedCommands` is managed.
- `node/chat/chat.ts`: `Chat.rememberedCommands` — the `Set<string>` for remembered bash commands
- `node/tools/types.ts`: `StaticTool` interface

## New interface

```typescript
// node/tools/shell.ts
export interface Shell {
  execute(command: string): Promise<ShellResult>;
}

export type ShellResult = {
  exitCode: number;
  signal: NodeJS.Signals | undefined;
  output: OutputLine[];
  logFilePath: string | undefined;
  durationMs: number;
};

export type OutputLine = {
  stream: "stdout" | "stderr";
  text: string;
};
```

# implementation

- [ ] Create `node/tools/shell.ts` with the `Shell` interface and `ShellResult` type
  - [ ] Define the interface with `execute(command: string): Promise<ShellResult>`
  - [ ] Define `ShellResult` including `exitCode`, `signal`, `output: OutputLine[]`, `logFilePath`, `durationMs`
  - [ ] Move the `OutputLine` type here from `bashCommand.ts`

- [ ] Create `node/tools/base-shell.ts` with `BaseShell` implementation
  - [ ] Move the core execution logic from `BashCommandTool.executeCommand()` here: child process spawning, stdout/stderr collection, log file management, ANSI stripping, timeout handling
  - [ ] Constructor takes `{ cwd: NvimCwd, threadId: ThreadId }` (what's needed for log file paths and cwd)
  - [ ] The `execute()` method returns a `Promise<ShellResult>` that resolves when the process exits
  - [ ] Move `initLogFile()`, `writeToLog()`, `closeLogStream()`, `stripAnsiCodes()` helpers here
  - [ ] Move `ANSI_ESCAPE_REGEX`, `MAX_CHARS_PER_LINE` constants here
  - [ ] Provide a way to terminate the running process (e.g. `terminate()` method or AbortSignal)

- [ ] Create `node/tools/permission-shell.ts` with `PermissionCheckingShell` decorator
  - [ ] Follow the pattern from `PermissionCheckingFileIO`: wrap a `Shell`, intercept `execute()`, check permissions first
  - [ ] Move `checkCommandPermissions()` logic here
  - [ ] Use the promise-based blocking pattern: if permission not granted, create a pending entry and block until user approves/denies
  - [ ] Manage `rememberedCommands: Set<string>` directly (passed in from `Chat`)
  - [ ] Implement `view()` for the YES/NO/ALWAYS approval UI (moved from `BashCommandTool.renderSummary()`)
  - [ ] Support `approve(remember?: boolean)` — if remember, add to `rememberedCommands` set directly (removing the need for thread.ts to handle this)
  - [ ] `deny()` — rejects the promise with an error
  - [ ] `getPendingPermissions()` — for view rendering

- [ ] Assemble the `Shell` layers in `Thread` constructor
  - [ ] Similar to how `FileIO` is assembled: `PermissionCheckingShell(new BaseShell(...), ...)`
  - [ ] Note: `BaseShell` needs per-request context (threadId for log paths, toolRequestId for log subdirectory), so either:
    - Option A: Make `Shell.execute()` accept additional context (like a request ID for log paths), or
    - Option B: Have `BaseShell` be a factory that creates per-request executors
    - Option C: Pass `threadId` at construction time, pass `toolRequestId` as part of the execute call
  - [ ] Choose the simplest approach — likely Option C since threadId is fixed per thread
  - [ ] Add `shell: Shell` to `CreateToolContext`
  - [ ] Store `permissionShell` on Thread (like `permissionFileIO`) for the view

- [ ] Simplify `BashCommandTool`
  - [ ] Remove all execution logic (child process spawning, log file management, ANSI stripping)
  - [ ] Remove permission checking from constructor — the `Shell` layer handles this
  - [ ] Remove "pending-user-action" state — the tool just calls `shell.execute()` and awaits the result. The permission layer blocks the promise until approved.
  - [ ] Remove "user-approval" message type and the YES/NO/ALWAYS UI from the tool
  - [ ] Remove "terminate" message — termination moves to the `Shell` layer
  - [ ] The tool state simplifies to: `processing` (waiting for commandIO.execute()) → `done`/`error`
  - [ ] Keep the tick interval for live timer display during `processing` state
  - [ ] Keep output formatting logic (`formatOutputForToolResult`) since that's about preparing the agent response
  - [ ] Keep rendering logic (renderSummary/renderPreview/renderDetail) but simplify since no more permission UI

- [ ] Update `create-tool.ts`
  - [ ] Add `shell` to `CreateToolContext`
  - [ ] Pass it to `BashCommandTool` constructor
  - [ ] Remove `rememberedCommands` from the bash_command case (now handled by `PermissionCheckingShell`)

- [ ] Remove the `rememberedCommands` handling from `thread.ts` (lines ~968-978)
  - [ ] The "remember" logic is now internal to `PermissionCheckingShell`

- [ ] Update Thread's `view()` to include `permissionShell.view()` alongside `permissionFileIO.view()`

- [ ] Check for type errors and iterate until they pass (`npx tsc --noEmit`)

- [ ] Create `node/tools/__tests__/shell.test.ts`
  - [ ] Create an `InMemoryShell` for testing (similar to `InMemoryFileIO`)
  - [ ] Test `PermissionCheckingShell` approve/deny/remember flows
  - [ ] Test `BaseShell` with simple commands (echo, exit codes)

- [ ] Update existing `BashCommandTool` tests
  - [ ] Tests should use `InMemoryShell` instead of spawning real processes
  - [ ] Verify the tool correctly handles `ShellResult` and formats output

- [ ] Run tests and iterate until they pass (`npx vitest run`)
