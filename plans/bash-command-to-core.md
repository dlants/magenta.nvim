# context

## Objective

Port the `bash_command` tool from `node/tools/bashCommand.ts` to `core/tools/`, following the established patterns from the EDL tool port. The core version delegates permissions, process spawning, and log file management to the environment's `CommandExec` interface, keeping only the tool's state machine and output formatting logic.

## Key interfaces

### `CommandExec` (core/tools/environment.ts)

```typescript
interface CommandExec {
  spawn(command: string, options: SpawnOptions): Promise<Result<CommandResult>>;
}
type SpawnOptions = {
  cwd: AbsFilePath;
  timeout?: number;
  abortSignal?: AbortSignal;
  onOutput?: (chunk: OutputChunk) => void;
};
type OutputChunk = { stream: "stdout" | "stderr"; text: string };
type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  signal: string | undefined;
  logFile: AbsFilePath | undefined;
};
```

- Permission checking, process spawning, log file creation, SIGTERM/SIGKILL escalation — all handled by the environment's `CommandExec` implementation.
- The tool passes an `AbortSignal` to enable abort/terminate.

### `Tool` / `StaticTool` (core/tools/types.ts)

Same interface as established by EdlTool: `isDone()`, `isPendingUserAction()`, `getToolResult()`, `abort()`, `update(msg)`.

### Node bash tool (node/tools/bashCommand.ts, 1179 lines)

- **States**: `processing`, `pending-user-action`, `done`, `error`
- **Msgs**: `stdout`, `stderr`, `exit`, `error`, `request-user-approval`, `user-approval`, `terminate`, `tick`
- **Output truncation**: `MAX_OUTPUT_TOKENS_FOR_AGENT=2000`, `MAX_CHARS_PER_LINE=800`, `CHARACTERS_PER_TOKEN=4`. Head 30% / tail 70% split with omission marker.
- **Description**: inline in `getSpec()`, conditionally appends rg/fd sections based on `which` availability.

## What stays vs. what gets removed

### Stays (pure tool logic)

- Output truncation: `abbreviateLine()`, `formatOutputForToolResult()` — formats stdout/stderr for the agent's tool result
- State machine: simplified to `processing` → `done` (no `pending-user-action`, no `error` — the environment returns errors as `Result`)
- Abort via `AbortController` → `abortSignal` in `SpawnOptions`
- Spec with `{ command: string }` input schema
- Description text (always include rg/fd sections — availability detection is environment concern)

### Removed (environment/client concerns)

- Permission checking (`checkCommandPermissions`, `isCommandAllowedByConfig`, `rememberedCommands`)
- `pending-user-action` state and YES/NO/ALWAYS UI flow
- Direct `child_process.spawn`, `detached: true`, process group kill, SIGTERM→SIGKILL escalation
- `withTimeout` wrapper (environment handles timeout via `SpawnOptions.timeout`)
- Log file creation/management (`initLogFile`, `logStream`)
- All view/render methods (`renderSummary`, `renderPreview`, `renderDetail`, etc.)
- `tick` message and timer interval (TUI concern)
- `nvim` dependency, `getDisplayWidth`, `openFileInNonMagentaWindow`
- ANSI code stripping (environment should return clean output)
- `spawnSync` for `which rg`/`which fd` checks

## Relevant files

- `node/tools/bashCommand.ts` — source to port from (1179 lines)
- `core/tools/edl-tool.ts` — reference pattern for core tool implementation
- `core/tools/specs/edl.ts` — reference pattern for spec file
- `core/tools/create-tool.ts` — factory to extend
- `core/tools/toolManager.ts` — registry to extend
- `core/tools/environment.ts` — `CommandExec`, `CommandResult`, `SpawnOptions` interfaces
- `core/tools/types.ts` — `Tool`, `StaticTool`, `ToolMsg`, `ToolContext`

# implementation

- [x] **Create spec file `core/tools/specs/bash-command.ts`**
  - `Input` type: `{ command: string }`
  - `validateInput(args)`: check `args.command` is a string
  - `spec: ProviderToolSpec` with name `"bash_command"`, description (always include rg/fd sections), and input_schema
  - `ToolRequest` type alias: `GenericToolRequest<"bash_command", Input>`

- [x] **Create `core/tools/bash-command-tool.ts`**
  - `OutputLine` type: `{ stream: "stdout" | "stderr"; text: string }`
  - State type: `{ state: "processing"; output: OutputLine[] } | { state: "done"; output: OutputLine[]; result: ProviderToolResult }`
  - Msg type: `{ type: "finish"; result: Result<ProviderToolResultContent[]> }`
  - `BashCommandTool` class implementing `StaticTool`
  - Constructor context: `{ commandExec: CommandExec, logger: Logger, cwd: Cwd, homeDir: HomeDir, myDispatch: Dispatch<Msg> }`
  - Constructor creates `AbortController`, schedules `executeCommand()` via `setTimeout`
  - `executeCommand()`:
    - Passes `onOutput` callback to `commandExec.spawn()` that pushes `OutputLine`s to `state.output`
    - Calls `commandExec.spawn(command, { cwd, timeout: 300_000, abortSignal, onOutput })`
    - On success: format output via `formatOutputForToolResult(result)`, dispatch `finish`
    - On error result: dispatch `finish` with error
  - `abort()`: calls `abortController.abort()`, sets state to done with abort message
  - Output truncation (pure functions, ported from node):
    - `abbreviateLine(line: string, maxChars: number): string`
    - `formatOutputForToolResult(result: CommandResult): ProviderToolResultContent[]`
    - Constants: `MAX_OUTPUT_TOKENS_FOR_AGENT=2000`, `MAX_CHARS_PER_LINE=800`, `CHARACTERS_PER_TOKEN=4`
  - `isDone()`, `isPendingUserAction()` (always false), `getToolResult()`, `update(msg)`
  - Clients can observe `state.output` for live-streaming display while the command runs

- [x] **Wire into factory and manager**
  - Add `bash_command` case to `core/tools/create-tool.ts` `createTool` switch
  - Add `bash_command` spec to `core/tools/toolManager.ts` `TOOL_SPEC_MAP`
  - Update `CreateToolContext` to include `commandExec: CommandExec`

- [x] **Type check**: run `npx tsc --noEmit` and fix any errors

- [x] **Write tests `core/tools/bash-command-tool.test.ts`**
  - **MockCommandExec**: a mock implementing `CommandExec` with:
    - A `handler: (command, options) => Promise<Result<CommandResult>>` function
    - The handler receives `options` including `onOutput`, so it can simulate streaming chunks during execution
    - A `calls` array tracking `{ command, options }` for assertions
    - For simple tests: handler returns a resolved `Result<CommandResult>` immediately
    - For abort tests: handler returns a promise gated on a deferred/never-resolving promise; the tool calls `abort()` while it's pending, then we verify state is `done` with abort message and the pending promise is ignored (tool checks `this.aborted`)
    - For streaming tests: handler calls `options.onOutput?.()` with chunks before resolving, then we verify `state.output` accumulated the lines
  - Test: successful command — dispatches finish with formatted output
  - Test: command failure (error result from environment) — dispatches finish with error
  - Test: command with non-zero exit code — result includes exit code in text
  - Test: command with signal — result includes signal in text
  - Test: output truncation — large output gets head/tail split
  - Test: line abbreviation — long lines get truncated
  - Test: abort before completion — returns abort result, pending promise ignored
  - Test: abort after completion — returns original result
  - Test: log file reference included when present
  - Test: streaming output — `onOutput` callback populates `state.output` during execution
  - Test: `validateInput` rejects missing/non-string command
  - Test: `createTool` with `"bash_command"` returns a `BashCommandTool`

- [x] **Run tests**: `cd core && npx vitest run tools/bash-command` and iterate until passing
