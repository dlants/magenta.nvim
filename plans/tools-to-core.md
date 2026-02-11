# Plan: Port Tools to Core

## Goal

Copy the tool system from `node/` into `core/`, making the environment concept crisp. Tools in core accept backend interfaces — they don't import `fs`, `child_process`, nvim, or permissions code. Permissions are an environment concern, enforced by backend wrappers outside the tool. Rendering is a client concern — tools provide structured display data, not VDOMNodes.

We are **copying**, not mutating `node/`. The existing `node/tools/` stays untouched.

## Current State of `core/`

- `core/runner/tools/types.ts` — has `ToolRequestId`, `ToolName`, `ToolRequest`, `ToolMsg`, `CompletedToolInfo`, `DisplayContext`
- `core/runner/tools/toolManager.ts` — re-exports `ToolRequestId` and `CompletedToolInfo`
- `core/runner/tools/helpers.ts` — stub `validateInput`
- `core/agent/provider-types.ts` — has `ProviderToolSpec`, `ProviderToolResult`, `ProviderToolResultContent`, `Agent`, `AgentMsg`, etc.
- `core/tea/tea.ts` — has `Dispatch<Msg>` type
- `core/logger.ts` — has `Logger` interface
- `core/options.ts` — has `MagentaOptions`, `CommandPermissions`, `FilePermission`, etc.
- `core/utils/files.ts` — has `AbsFilePath`, `Cwd`, `HomeDir`, etc.
- **No** `FileIO`, `CommandExec`, or `Environment` interfaces exist yet
- **tsconfig.json** includes `tools/**/*` but NOT `runner/**/*` — need to fix path mismatch

## Design Principles

1. **Tools accept backend interfaces** — `FileIO`, `CommandExec`, `LspCapabilities` are injected via constructor context. Tools never import `fs`, `child_process`, or nvim.

2. **Permissions are Result errors** — Backend interfaces return `Result` types. A permission denial is just an error result from `fileIO.readFile()` or `commandExec.spawn()`. The tool handles the Result like any other error — no special permission logic needed. The environment intercepts calls, checks policy (auto-approve, deny, or ask user), and returns the Result.

3. **No view logic** — Tools just produce `ToolRequest` and `ToolResult`. View/rendering is a client concern handled later. No dependency on `node/tea/view.ts`.

4. **LSP is part of the environment** — LSP/editor operations use an `LspCapabilities` interface provided by the environment. Clients attach/detach, so we can't rely on them existing. The environment implementation handles routing to a client if one is attached, or failing gracefully if not. In tests, it's mocked.

5. **Same message/dispatch pattern** — Tools still use `Dispatch<Msg>` for internal state transitions and `myDispatch` for self-messaging.

## Architecture Overview

```
Environment (wraps backends with permissions)
  ├── fileIO: FileIO           ← backs get_file, list_directory, edl
  ├── commandExec: CommandExec ← backs bash_command
  └── (lifecycle: checkpoint, restore, dispose — not relevant to tools)

Environment also provides:
  ├── lsp: LspCapabilities     ← backs hover, find_references, diagnostics
  └── (clients attach/detach, so LSP lives in env, not client)

Tool receives:
  - Backend interface(s) it needs (from environment)
  - LSP capabilities (from environment — client may or may not be attached)
  - Logger, Cwd, HomeDir (from context)
  - myDispatch (for self-messaging)
```

## Steps

### Step 0: Fix tsconfig and directory structure

- [x] Move `core/runner/tools/` → `core/tools/` (tsconfig includes `tools/**/*` not `runner/tools/**/*`)
- [x] Update imports in `core/agent/provider-types.ts` and `core/agent/anthropic.ts` to use `../tools/` paths
- [x] Remove empty `core/runner/` directory
- [x] Verify `npx tsc --noEmit` still passes in core/

### Step 1: Define backend interfaces

- [x] Create `core/tools/environment.ts` with:
  - `FileIO` interface — returns `Result` so permission denials are just errors:
    - `readFile(path): Promise<Result<string>>` — may fail with permission denial
    - `writeFile(path, content): Promise<Result<void>>` — may fail with permission denial
    - `fileExists(path): Promise<Result<boolean>>`
    - `mkdir(path): Promise<Result<void>>`
    - `readDir(path): Promise<Result<DirEntry[]>>` (add readDir vs node/edl's FileIO which lacks it)
  - `CommandExec` interface — same pattern, permission denial is a Result error:
    - `spawn(command, options): Promise<Result<CommandResult>>` — environment parses the command, checks policy, returns error or executes
  - `LspCapabilities` interface: `hover(params)`, `findReferences(params)`, `getDiagnostics()` — each returns a Promise. Part of the environment, not a client dependency.
  - `AgentControl` interface: `spawnSubagent(config)`, `getThreadResult(threadId)`, `getThreadSummary(threadId)`, `compactThread(request)`
  - The environment wraps these interfaces — it intercepts calls, checks permissions (auto-approve, deny, or prompt user), and returns the Result. Tools just handle Results.

### Step 2: Define the core Tool interface

- [x] Update `core/tools/types.ts`:
  - Keep existing `ToolRequestId`, `ToolName`, `ToolRequest`, `ToolMsg`, `CompletedToolInfo`, `DisplayContext`
  - Add `Tool` interface (replaces node's VDOMNode-based interface):
    - `toolName`, `aborted`, `request`
    - `isDone()`, `isPendingUserAction()`, `getToolResult()`
    - `abort()`
    - `update(msg: ToolMsg): void`
  - No view/display methods — view is derived from request + result on the client side
  - Add `StaticTool` interface extending `Tool` with `StaticToolName` constraint
- [x] Define `ToolContext` type — the shared context all tools receive:
  - `logger: Logger`
  - `cwd: Cwd`
  - `homeDir: HomeDir`
  - `myDispatch: Dispatch<ToolMsg>`

### Step 3: Copy the EDL engine

- [x] Copy `node/edl/` → `core/edl/` (parser.ts, document.ts, executor.ts, types.ts, file-io.ts, index.ts)
- [x] Copy test files: parser.test.ts, document.test.ts, executor.test.ts, index.test.ts, fixtures/, **snapshots**/
- [x] Update `core/edl/file-io.ts`:
  - The EDL FileIO is a subset of the environment FileIO (lacks readDir). Keep it as-is for now — the EDL engine uses its own FileIO interface. The tool passes environment.fileIO which satisfies both.
  - Remove `FsFileIO` class (environment implementation concern) or keep it for EDL tests only.
- [x] Add `edl/**/*` to `core/tsconfig.json` includes
- [x] Verify EDL tests pass: `cd core && npx vitest run edl/`

### Step 4: Port EDL tool end-to-end

Port the EDL tool completely — spec, implementation, factory wiring, tests — as the first tool through the pipeline. This validates the full Tool interface, ToolContext, and factory patterns before porting others.

#### 4a: EDL tool spec

- [x] Create `core/tools/specs/edl.ts` containing:
  - `spec: ProviderToolSpec` — the JSON schema for the tool's input
  - `Input` type — TypeScript type for validated input
  - `validateInput(input): Result<Input>` — input validation
  - `ToolRequest` type alias — `GenericToolRequest<"edl", Input>`

#### 4b: EDL tool implementation

- [x] Create `core/tools/edl-tool.ts`
- [x] Constructor context: `{ fileIO: FileIO, logger: Logger, cwd: Cwd, homeDir: HomeDir, myDispatch, edlRegisters }`
- [x] Remove: permission checks, `BufferAwareFileIO`, `BufferTracker`, context manager updates
- [x] Keep: EDL script execution via `core/edl/runScript()`, register management, description loading
- [x] The FileIO passed to the EDL engine is adapted via createEdlFileIO (unwraps Results, resolves paths)

#### 4c: Tool manager and factory (minimal, for EDL)

- [x] Create `core/tools/create-tool.ts` — factory function, initially just handling EDL:
  - `CreateToolContext` type with all backend interfaces
  - `createTool(request, context)` → instantiates the right tool class
- [x] Update `core/tools/toolManager.ts` — replace the stub with enough to support EDL:
  - `getToolSpecs(threadType, additionalSpecs?)` → returns `ProviderToolSpec[]`
  - `TOOL_SPEC_MAP` — maps tool names to specs (initially just EDL)
  - Grows as more tools are added

#### 4d: EDL tool tests

- [x] Write tests with mock FileIO
- [x] Verify `cd core && npx vitest run tools/`
- [x] Verify `npx tsc --noEmit` passes (no new errors)

### Step 5: Port remaining tools one at a time

For each tool below, follow the same pattern: create spec, implement tool, add to factory/manager, write tests, verify compilation. Order is flexible — tackle whatever is most useful next.

#### Pure tools (no environment backends)

- [ ] `thread_title` — trivial, just sets title
- [ ] `yield_to_parent` — dispatches result to parent

#### FileIO-backed tools

- [ ] `get_file` — file reading via `fileIO.readFile()`, line range selection, file size handling
  - Remove: `canReadFile()` checks, nvim buffer access, treesitter minimap, ContextManager updates, PDF extraction
- [ ] `list_directory` — BFS traversal, gitignore parsing via `fileIO.readDir()` + `fileIO.readFile()`
  - Remove: `canReadFile()` checks, direct `fs.readdir` calls

#### CommandExec-backed tools

- [ ] `bash_command` — command execution via `commandExec.spawn()`, output truncation
  - Remove: permission checking, `rememberedCommands`, YES/NO/ALWAYS handling, direct `child_process.spawn`

#### LSP-backed tools

- [ ] `hover` — uses `lsp.hover()`. Remove: direct nvim access, `Lsp` class usage
- [ ] `find_references` — uses `lsp.findReferences()`
- [ ] `diagnostics` — uses `lsp.getDiagnostics()`

#### Agent-internal tools

- [ ] `spawn_subagent` — uses `agentControl.spawnSubagent()`
- [ ] `spawn_foreach` — uses `AgentControl` for spawning and polling
- [ ] `wait_for_subagents` — uses `agentControl.getThreadResult()` and `getThreadSummary()`
- [ ] `compact` — uses `agentControl.compactThread()`

### Step 6: Copy bash-parser (for environment use)

- [ ] Copy `node/tools/bash-parser/` → `core/tools/bash-parser/`
- [ ] Note: In core, this is used by the **environment**, not the tool. The `local` environment uses `isCommandAllowedByConfig()` in its `CommandExec` wrapper.
- [ ] Verify tests pass

### Step 7: Final verification

- [ ] Update `core/tsconfig.json` includes to cover all new directories
- [ ] Run `npx tsc --noEmit` from project root
- [ ] Run `cd core && npx vitest run`
- [ ] Fix any issues
