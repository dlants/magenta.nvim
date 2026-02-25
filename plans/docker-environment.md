# Context

**Objective**: Introduce an "agent environment" abstraction. Currently, all file I/O and shell execution happens locally on the host. We want to add a Docker environment where file operations and shell commands execute inside a specified Docker container, while LSP-based tools (hover, find_references, diagnostics) are disabled.

**Key design insight**: The codebase already has clean capability interfaces (`FileIO`, `Shell`) in `@magenta/core` with swappable implementations. The Docker environment is achieved by providing alternative implementations of these interfaces, plus filtering out LSP tools. No changes to individual tool logic are needed.

## Key types and interfaces

- `FileIO` (`node/core/src/capabilities/file-io.ts`): interface for file operations (readFile, writeFile, fileExists, mkdir, stat). Current impls: `FsFileIO` (core), `BufferAwareFileIO` (root, nvim-aware), `InMemoryFileIO` (core, tests), `PermissionCheckingFileIO` (root, decorator).
- `Shell` (`node/core/src/capabilities/shell.ts`): interface for shell command execution. Current impls: `BaseShell` (root, local spawning), `PermissionCheckingShell` (root, decorator).
- `LspClient` (`node/core/src/capabilities/lsp-client.ts`): interface for LSP hover, references, definition, type definition. Implemented by `node/capabilities/lsp-client-adapter.ts`.
- `DiagnosticsProvider` (`node/core/src/capabilities/diagnostics-provider.ts`): single-method interface `getDiagnostics(): Promise<string>`.
- `CreateToolContext` (`node/core/src/tools/create-tool.ts`): the full set of capabilities passed to the tool factory, including `fileIO`, `shell`, `lspClient`, `diagnosticsProvider`, etc.
- `StaticToolName` / tool name lists (`node/core/src/tools/tool-registry.ts`): determines which tools are available per thread type (`CHAT_STATIC_TOOL_NAMES`, `SUBAGENT_STATIC_TOOL_NAMES`, etc.).
- `getToolSpecs` (`node/core/src/tools/toolManager.ts`): assembles the tool spec list sent to the LLM. Takes `threadType` and `mcpToolManager`.
- `MagentaOptions` (`node/options.ts`): plugin configuration, parsed from Lua.
- `Thread` (`node/chat/thread.ts`): assembles capabilities (FileIO chain, Shell chain) in its constructor and builds `CreateToolContext` when handling tool use.

## Relevant files

- `node/core/src/capabilities/file-io.ts` — `FileIO` interface + `FsFileIO`
- `node/core/src/capabilities/shell.ts` — `Shell` interface + types
- `node/core/src/capabilities/lsp-client.ts` — `LspClient` interface
- `node/core/src/capabilities/diagnostics-provider.ts` — `DiagnosticsProvider` interface
- `node/core/src/tools/tool-registry.ts` — static tool name sets per thread type
- `node/core/src/tools/toolManager.ts` — `getToolSpecs` assembles tool list for LLM
- `node/core/src/tools/create-tool.ts` — `createTool` factory dispatches to tool executors
- `node/capabilities/base-shell.ts` — `BaseShell`: local shell via `child_process.spawn`
- `node/capabilities/buffer-file-io.ts` — `BufferAwareFileIO`: reads/writes nvim buffers
- `node/capabilities/permission-file-io.ts` — `PermissionCheckingFileIO` decorator
- `node/capabilities/permission-shell.ts` — `PermissionCheckingShell` decorator
- `node/chat/thread.ts` — Thread constructor assembles FileIO/Shell chains, creates tools
- `node/chat/chat.ts` — `createThreadWithContext()` creates threads with context
- `node/options.ts` — `MagentaOptions` definition, parsing, merging
- `lua/magenta/options.lua` — Lua-side option defaults

## Architecture decisions

1. **Environment config location**: Top-level in `MagentaOptions` (not per-profile), since environment (where tools execute) is orthogonal to profile (which AI provider to use). Also settable via `.magenta/options.json` for per-project config.

2. **Docker implementations location**: In `node/capabilities/` (root project), alongside `BaseShell` and `BufferAwareFileIO`. They use `child_process.spawn` to run `docker exec` commands on the host.

3. **Docker FileIO approach**: `DockerFileIO` implements `FileIO` by running `docker exec <container>` commands (e.g., `cat` for reads, `tee` for writes, `stat`, `test -f`, `mkdir -p`). **Not** wrapped in `PermissionCheckingFileIO` or `BufferAwareFileIO` — all operations inside the container are auto-allowed since the container provides its own isolation boundary.

4. **Docker Shell approach**: `DockerShell` implements `Shell` by spawning `docker exec -w <cwd> <container> bash -c <command>` as a local child process. Output capture, log file writing, and timeouts happen on the host (similar to `BaseShell`). **Not** wrapped in `PermissionCheckingShell` — all commands inside the container are auto-allowed.

5. **LSP tool exclusion**: `getToolSpecs` gains an optional `excludedTools` parameter (a `Set<StaticToolName>`). The Thread/Chat layer passes the Docker-excluded set (`hover`, `find_references`, `diagnostics`) when in Docker mode. No-op stubs are provided for `LspClient` and `DiagnosticsProvider` so `CreateToolContext` remains fully populated (avoiding type gymnastics). If a tool somehow gets invoked despite not being in the spec list, it returns an error message.

6. **cwd / homeDir**: In Docker mode, `cwd` is the working directory inside the container (configurable, defaults to container's `$HOME` or `/`). `homeDir` is the home directory inside the container. These are branded string types so they work with existing path resolution. They can either be specified in config or queried from the container at startup.

# Pre-work (can land independently)

## Pre-work A: Capability-driven tool filtering

Currently tool lists are hardcoded per thread type. Instead, make `getToolSpecs` accept a set of available capabilities and only include tools whose dependencies are satisfied. This is useful independently — e.g., users without LSP configured shouldn't see hover/find_references/diagnostics offered to the LLM.

- [ ] **A1: Map tools to required capabilities**
  - [ ] Define a `ToolCapability` type in `tool-registry.ts` (e.g., `"lsp"`, `"shell"`, `"diagnostics"`, `"threads"`, `"file-io"`)
  - [ ] Add a `TOOL_REQUIRED_CAPABILITIES` map from `StaticToolName` to `Set<ToolCapability>`:
    - `hover`, `find_references` → `{"lsp"}`
    - `diagnostics` → `{"diagnostics"}`
    - `bash_command` → `{"shell"}`
    - `spawn_subagent`, `spawn_foreach`, `wait_for_subagents` → `{"threads"}`
    - `get_file`, `edl` → `{"file-io"}` (always available)
    - `thread_title`, `yield_to_parent` → no requirements
  - [ ] Type-check: `npx tsgo -b`

- [ ] **A2: Update `getToolSpecs` to filter by capabilities**
  - [ ] Add an optional `availableCapabilities?: Set<ToolCapability>` parameter to `getToolSpecs`
  - [ ] When provided, filter the static tool names to only those whose required capabilities are all present in the set
  - [ ] When not provided, include all tools for the thread type (backward compatible)
  - [ ] Update call sites to pass capabilities (for now, all local capabilities — no behavior change)
  - [ ] Type-check: `npx tsgo -b`
  - [ ] Run tests: `npx vitest run`

## Pre-work B: Extract capability assembly from Thread into an Environment abstraction

Thread's constructor currently hardcodes the local capability chain (BufferAwareFileIO → PermissionCheckingFileIO, BaseShell → PermissionCheckingShell, real LSP adapter). Extract this into an `Environment` interface so Thread just consumes pre-assembled capabilities.

- [ ] **B1: Define the `Environment` interface**
  - [ ] Create a type (in root, e.g. `node/environment.ts`) that bundles the capabilities an environment provides:
    ```
    interface Environment {
      fileIO: FileIO;
      permissionFileIO?: PermissionCheckingFileIO;
      shell: Shell;
      permissionShell?: PermissionCheckingShell;
      lspClient: LspClient;
      diagnosticsProvider: DiagnosticsProvider;
      availableCapabilities: Set<ToolCapability>;
      cwd: NvimCwd;
      homeDir: HomeDir;
    }
    ```
  - [ ] Type-check: `npx tsgo -b`

- [ ] **B2: Create `LocalEnvironment` factory**
  - [ ] Extract the existing capability assembly logic from Thread's constructor into a `createLocalEnvironment(...)` function
  - [ ] This produces the current behavior: BufferAwareFileIO → PermissionCheckingFileIO, BaseShell → PermissionCheckingShell, real LSP, real diagnostics, all capabilities available
  - [ ] Type-check: `npx tsgo -b`

- [ ] **B3: Refactor Thread to consume Environment**
  - [ ] Thread constructor receives an `Environment` instead of assembling capabilities itself
  - [ ] Thread reads `fileIO`, `shell`, `lspClient`, etc. from the environment
  - [ ] Thread passes `environment.availableCapabilities` to `getToolSpecs`
  - [ ] Existing tests continue to work (they can inject capabilities or use `createLocalEnvironment`)
  - [ ] Type-check: `npx tsgo -b`
  - [ ] Run tests: `npx vitest run`

## Pre-work C: Extract reusable shell utilities from BaseShell

`BaseShell` contains output capture, ANSI stripping, timeout, and log file writing logic that `DockerShell` will also need. Extract these into shared utilities so both implementations can reuse them.

- [ ] **C1: Extract shared utilities**
  - [ ] Move ANSI stripping (`stripAnsiCodes`) to a shared module (e.g., `node/capabilities/shell-utils.ts`)
  - [ ] Extract the output capture loop (stdout/stderr line buffering, `onOutput` callbacks) into a reusable helper
  - [ ] Extract the timeout wrapper logic
  - [ ] Extract log file writing into a pluggable function (takes a write strategy — local fs vs DockerFileIO)
  - [ ] Type-check: `npx tsgo -b`

- [ ] **C2: Refactor BaseShell to use extracted utilities**
  - [ ] BaseShell delegates to the shared utilities instead of inlining the logic
  - [ ] Behavior is identical — this is a pure refactor
  - [ ] Type-check: `npx tsgo -b`
  - [ ] Run tests: `npx vitest run`

# Docker implementation (depends on pre-work)

With the pre-work in place, adding Docker is straightforward: implement a new `Environment` and wire it up.

- [ ] **Step 1: Define environment config in options**
  - [ ] In `node/options.ts`, define `EnvironmentConfig` type:
    ```
    type EnvironmentConfig =
      | { type: "local" }
      | { type: "docker"; container: string; cwd?: string }
    ```
  - [ ] Add `environment?: EnvironmentConfig` field to `MagentaOptions` (defaults to `{ type: "local" }`)
  - [ ] Add parsing logic in `parseOptions` and `parseProjectOptions`
  - [ ] Add merge logic in `mergeOptions` (project overrides base)
  - [ ] Update `lua/magenta/options.lua` with the default
  - [ ] Type-check: `npx tsgo -b`

- [ ] **Step 2: Create `DockerFileIO`**
  - [ ] Create `node/capabilities/docker-file-io.ts`
  - [ ] Implement `FileIO` interface using `child_process.execFile` to run `docker exec` commands:
    - `readFile(path)` → `docker exec <container> cat <path>`
    - `readBinaryFile(path)` → `docker exec <container> cat <path>` (capture as Buffer)
    - `writeFile(path, content)` → pipe content via stdin to `docker exec -i <container> tee <path>`
    - `fileExists(path)` → `docker exec <container> test -f <path> -o -d <path>` (check exit code)
    - `mkdir(path)` → `docker exec <container> mkdir -p <path>`
    - `stat(path)` → `docker exec <container> stat -c %Y <path>` (parse mtime)
  - [ ] Write unit tests
  - [ ] Type-check: `npx tsgo -b`

- [ ] **Step 3: Create `DockerShell`**
  - [ ] Create `node/capabilities/docker-shell.ts`
  - [ ] Implement `Shell` interface:
    - `execute(command, opts)`: spawn `docker exec -w <cwd> <container> bash -c <command>` as a local child process. Reuse output capture / log file / timeout patterns from `BaseShell`.
    - `terminate()`: must cleanly kill the command and all its children inside the container. Approach: run commands via `docker exec <container> setsid bash -c '<command>'` so they get their own process group inside the container. On terminate, issue `docker exec <container> kill -- -<pgid>` to kill the entire group, then kill the local `docker exec` process. This mirrors how `BaseShell` uses detached process groups locally.
  - [ ] Extract shared utilities from `BaseShell` if there's significant duplication
  - [ ] Log files must be written inside the container (so the agent can read them via `DockerFileIO`). After capturing output locally, write the log via `DockerFileIO.writeFile()` to a container path like `/tmp/magenta-logs/<threadId>/<toolRequestId>.log`.
  - [ ] Write unit tests
  - [ ] Type-check: `npx tsgo -b`

- [ ] **Step 4: Create no-op LSP/diagnostics stubs**
  - [ ] `node/capabilities/noop-lsp-client.ts`: implements `LspClient`, all methods return empty arrays
  - [ ] `node/capabilities/noop-diagnostics-provider.ts`: implements `DiagnosticsProvider`, returns "not available in Docker"
  - [ ] Type-check: `npx tsgo -b`

- [ ] **Step 5: Create `DockerEnvironment` factory**
  - [ ] Create `createDockerEnvironment(config)` that assembles:
    - `DockerFileIO` directly (no permission wrapping)
    - `DockerShell` directly (no permission wrapping)
    - No-op LSP client and diagnostics provider
    - `availableCapabilities`: `{"file-io", "shell", "threads"}` (no `"lsp"`, no `"diagnostics"`)
    - `cwd` from config or queried via `docker exec <container> pwd`
    - `homeDir` queried via `docker exec <container> sh -c 'echo $HOME'`
  - [ ] Type-check: `npx tsgo -b`

- [ ] **Step 6: Wire up in Chat/Thread creation**
  - [ ] In `createThreadWithContext`, check `options.environment` and call `createLocalEnvironment` or `createDockerEnvironment` accordingly
  - [ ] Pass the resulting `Environment` to Thread
  - [ ] Type-check: `npx tsgo -b`
  - [ ] Run tests: `npx vitest run`

- [ ] **Step 7: Integration testing & documentation**
  - [ ] Write integration test verifying Docker environment tool filtering and capability wiring
  - [ ] Update `context.md`
