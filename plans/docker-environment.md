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

1. **Environment config location**: Per-thread, not global. Each thread is created with an optional `EnvironmentConfig`. Default is local. Docker threads are created ad-hoc by passing a container ID. Subagent threads inherit their parent's environment config.

2. **Docker implementations location**: In `node/capabilities/` (root project), alongside `BaseShell` and `BufferAwareFileIO`. They use `child_process.spawn` to run `docker exec` commands on the host.

3. **Docker FileIO approach**: `DockerFileIO` implements `FileIO` by running `docker exec <container>` commands (e.g., `cat` for reads, `tee` for writes, `stat`, `test -f`, `mkdir -p`). **Not** wrapped in `PermissionCheckingFileIO` or `BufferAwareFileIO` — all operations inside the container are auto-allowed since the container provides its own isolation boundary.

4. **Docker Shell approach**: `DockerShell` implements `Shell` by spawning `docker exec -w <cwd> <container> bash -c <command>` as a local child process. Output capture, log file writing, and timeouts happen on the host (similar to `BaseShell`). **Not** wrapped in `PermissionCheckingShell` — all commands inside the container are auto-allowed.

5. **LSP tool exclusion**: `getToolSpecs` accepts `availableCapabilities` (from pre-work A). Docker environments omit `"lsp"` and `"diagnostics"` capabilities, so those tools are automatically filtered out. No-op stubs are provided for `LspClient` and `DiagnosticsProvider` so `CreateToolContext` remains fully populated (avoiding type gymnastics).

6. **cwd / homeDir**: In Docker mode, `cwd` is the working directory inside the container (configurable, defaults to container's `$HOME` or `/`). `homeDir` is the home directory inside the container. These are branded string types so they work with existing path resolution. They can either be specified in config or queried from the container at startup.

# Pre-work (can land independently)

## Pre-work A: Capability-driven tool filtering

Currently tool lists are hardcoded per thread type. Instead, make `getToolSpecs` accept a set of available capabilities and only include tools whose dependencies are satisfied. This is useful independently — e.g., users without LSP configured shouldn't see hover/find_references/diagnostics offered to the LLM.

- [x] **A1: Map tools to required capabilities**
  - [x] Define a `ToolCapability` type in `tool-registry.ts` (e.g., `"lsp"`, `"shell"`, `"diagnostics"`, `"threads"`, `"file-io"`)
  - [x] Add a `TOOL_REQUIRED_CAPABILITIES` map from `StaticToolName` to `Set<ToolCapability>`:
    - `hover`, `find_references` → `{"lsp"}`
    - `diagnostics` → `{"diagnostics"}`
    - `bash_command` → `{"shell"}`
    - `spawn_subagent`, `spawn_foreach`, `wait_for_subagents` → `{"threads"}`
    - `get_file`, `edl` → `{"file-io"}` (always available)
    - `thread_title`, `yield_to_parent` → no requirements
  - [x] Type-check: `npx tsgo -b`

- [x] **A2: Update `getToolSpecs` to filter by capabilities**
  - [x] Add an optional `availableCapabilities?: Set<ToolCapability>` parameter to `getToolSpecs`
  - [x] When provided, filter the static tool names to only those whose required capabilities are all present in the set
  - [x] When not provided, include all tools for the thread type (backward compatible)
  - [x] Update call sites to pass capabilities (for now, all local capabilities — no behavior change)
  - [x] Type-check: `npx tsgo -b`
  - [x] Run tests: `npx vitest run`

## Pre-work B: Extract capability assembly from Thread into an Environment abstraction

Thread's constructor currently hardcodes the local capability chain (BufferAwareFileIO → PermissionCheckingFileIO, BaseShell → PermissionCheckingShell, real LSP adapter). Extract this into an `Environment` interface so Thread just consumes pre-assembled capabilities.

- [x] **B1: Define the `Environment` interface**
  - [x] Create a type (in root, e.g. `node/environment.ts`) that bundles the capabilities an environment provides:
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
  - [x] Type-check: `npx tsgo -b`

- [x] **B2: Create `LocalEnvironment` factory**
  - [x] Extract the existing capability assembly logic from Thread's constructor into a `createLocalEnvironment(...)` function
  - [x] This produces the current behavior: BufferAwareFileIO → PermissionCheckingFileIO, BaseShell → PermissionCheckingShell, real LSP, real diagnostics, all capabilities available
  - [x] Type-check: `npx tsgo -b`

- [x] **B3: Refactor Thread to consume Environment**
  - [x] Thread constructor receives an `Environment` instead of assembling capabilities itself
  - [x] Thread reads `fileIO`, `shell`, `lspClient`, etc. from the environment
  - [x] Thread passes `environment.availableCapabilities` to `getToolSpecs`
  - [x] Existing tests continue to work (they can inject capabilities or use `createLocalEnvironment`)
  - [x] Type-check: `npx tsgo -b`
  - [x] Run tests: `npx vitest run`

## Pre-work C: Extract reusable shell utilities from BaseShell

`BaseShell` contains output capture, ANSI stripping, timeout, and log file writing logic that `DockerShell` will also need. Extract these into shared utilities so both implementations can reuse them.

- [x] **C1: Extract shared utilities**
  - [x] Move ANSI stripping (`stripAnsiCodes`) to a shared module (e.g., `node/capabilities/shell-utils.ts`)
  - [x] Extract the output capture loop (stdout/stderr line buffering, `onOutput` callbacks) into a reusable helper
  - [x] Extract the timeout wrapper logic
  - [x] Extract log file writing into a pluggable function (takes a write strategy — local fs vs DockerFileIO)
  - [x] Type-check: `npx tsgo -b`

- [x] **C2: Refactor BaseShell to use extracted utilities**
  - [x] BaseShell delegates to the shared utilities instead of inlining the logic
  - [x] Behavior is identical — this is a pure refactor
  - [x] Type-check: `npx tsgo -b`
  - [x] Run tests: `npx vitest run`

# Docker implementation (depends on pre-work)

With the pre-work in place, adding Docker is straightforward: implement Docker capability classes, a `createDockerEnvironment` factory, and wire it into thread creation.

Environment is per-thread: each thread is created with an `EnvironmentConfig` (defaults to local). Docker threads are created ad-hoc by specifying a container ID. Subagent threads inherit their parent's environment.

- [x] **Step 1: Define `EnvironmentConfig` type**
  - [ ] In `node/environment.ts`, define:
    ```
    type EnvironmentConfig =
      | { type: "local" }
      | { type: "docker"; container: string; cwd?: string }
    ```
  - [ ] Add `environmentConfig` field to `Environment` interface so threads can access their config (e.g. for subagent inheritance)
  - [ ] Type-check: `npx tsgo -b`

- [x] **Step 2: Create `DockerFileIO`**
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

- [x] **Step 3: Create `DockerShell`**
  - [ ] Create `node/capabilities/docker-shell.ts`
  - [ ] Implement `Shell` interface:
    - `execute(command, opts)`: spawn `docker exec -w <cwd> <container> bash -c <command>` as a local child process. Reuse shell-utils for output capture, log writing, ANSI stripping.
    - `terminate()`: kill the local `docker exec` process (which propagates signal into the container). Use `terminateProcess`/`escalateToSigkill` from shell-utils.
  - [ ] Log files written locally (host-side) via `createLogWriter` — same as `BaseShell`. Agent can read them via `get_file` since log paths are on the host filesystem.
  - [ ] Write unit tests
  - [ ] Type-check: `npx tsgo -b`

- [x] **Step 4: Create no-op LSP/diagnostics stubs**
  - [ ] `node/capabilities/noop-lsp-client.ts`: implements `LspClient`, all methods return empty arrays
  - [ ] `node/capabilities/noop-diagnostics-provider.ts`: implements `DiagnosticsProvider`, returns "not available in Docker environment"
  - [ ] Type-check: `npx tsgo -b`

- [x] **Step 5: Create `createDockerEnvironment` factory**
  - [ ] In `node/environment.ts`, add `createDockerEnvironment(config)` that assembles:
    - `DockerFileIO` directly (no permission wrapping)
    - `DockerShell` directly (no permission wrapping)
    - No-op LSP client and diagnostics provider
    - `availableCapabilities`: `{"file-io", "shell", "threads"}` (no `"lsp"`, no `"diagnostics"`)
    - `cwd` from config or queried via `docker exec <container> pwd`
    - `homeDir` queried via `docker exec <container> sh -c 'echo $HOME'`
    - `environmentConfig` stored on the environment for subagent inheritance
  - [ ] Type-check: `npx tsgo -b`

- [x] **Step 6: Wire up per-thread environment in Chat/Thread creation**
  - [ ] Add optional `environmentConfig?: EnvironmentConfig` to `createThreadWithContext` params
  - [ ] When creating a thread, call `createLocalEnvironment` or `createDockerEnvironment` based on the config
  - [ ] Subagent thread creation inherits `environmentConfig` from parent thread's environment
  - [ ] Pass the resulting `Environment` (with `availableCapabilities`) to Thread
  - [ ] Thread passes `availableCapabilities` to `getToolSpecs`
  - [ ] Type-check: `npx tsgo -b`
  - [ ] Run tests: `npx vitest run`

- [ ] **Step 7: Integration testing & documentation**
  - [ ] Write integration test verifying Docker environment tool filtering and capability wiring
  - [ ] Test subagent environment inheritance
  - [ ] Update `context.md`

## Integration Test Plan for Docker Environment

### Test File

`node/capabilities/docker-environment.test.ts`

### Test Structure

**Setup/Teardown:**

- `beforeAll`: Start a container (`docker run -d bash:latest tail -f /dev/null`) and store the container ID. Skip the entire suite with `describe.skipIf` if `docker` CLI is unavailable.
- `afterAll`: `docker rm -f <containerId>`

### Test Cases

**Layer 1: DockerFileIO (single test, real Docker)**

One test exercises the full FileIO surface sequentially:

- `mkdir("/tmp/test-dir/nested")` — create nested directory
- `fileExists("/tmp/test-dir/nested")` → `true`
- `fileExists("/tmp/nonexistent")` → `false`
- `writeFile("/tmp/test-dir/hello.txt", "hello world")` then `readFile` → assert content matches
- `writeFile` with binary-like content, `readBinaryFile` → verify Buffer
- `stat("/tmp/test-dir/hello.txt")` → `mtimeMs` is a reasonable recent timestamp
- `stat("/tmp/nonexistent")` → `undefined`

**Layer 2: DockerShell (single test, real Docker)**

One test exercises the full Shell surface sequentially:

- `execute("echo hello")` → `exitCode: 0`, output contains "hello"
- `execute("exit 42")` → `exitCode: 42`
- `execute("pwd")` → output matches configured `cwd`
- After a command, verify `logFilePath` exists on host and contains the command + output
- Start `sleep 60`, call `terminate()`, verify it resolves within a few seconds with a signal

**Layer 3: createDockerEnvironment factory**

11. **Resolves cwd/homeDir from container**: Call `createDockerEnvironment` without `cwd`, verify `cwd` and `homeDir` are reasonable paths from inside the container.
12. **Uses provided cwd**: Call with explicit `cwd: "/tmp"`, verify `environment.cwd` is `/tmp`.
13. **Correct capabilities**: Verify `availableCapabilities` contains `file-io`, `shell`, `threads` and does NOT contain `lsp`, `diagnostics`.
14. **environmentConfig stored**: Verify `environmentConfig` is `{ type: "docker", container, cwd }`.
15. **No permission wrappers**: Verify `permissionFileIO` and `permissionShell` are `undefined`.

**Layer 4: Tool filtering integration**

16. **getToolSpecs filters correctly**: Call `getToolSpecs("root", mockMcpToolManager, environment.availableCapabilities)` and verify `hover`, `find_references`, `diagnostics` are excluded while `get_file`, `edl`, `bash_command`, `spawn_subagent`, etc. are included.

**Layer 5: Full driver integration (agent flow)**

17. **End-to-end Docker thread**: Use `withDriver` + mock provider. This requires wiring `environmentConfig` into the thread creation path accessible from the driver. Since `createNewThread` doesn't accept an `environmentConfig` yet, this test would:
    - Directly call `createDockerEnvironment` to create the environment
    - Call `getToolSpecs` with its capabilities
    - Verify the tool list excludes LSP tools
    - Exercise `DockerFileIO` and `DockerShell` through the environment's `fileIO` and `shell` interfaces

### Docker Availability Check

```typescript
async function isDockerAvailable(): Promise<boolean> {
  try {
    await execFile("docker", ["info"]);
    return true;
  } catch {
    return false;
  }
}
```

Use `describe.skipIf(!dockerAvailable)` at the top level.

### Container Image

Use `bash:latest` — small image that includes bash out of the box (needed since `DockerShell` runs `bash -c`).
