# context

The goal is to physically move `node/tools/` into `node/core/src/tools/` so it becomes part of the `@magenta/core` package.

This follows the same pattern as the providers migration (`move-providers-to-core.md`). Key findings from the analysis:

- **Rendering is already separated**: `node/render-tools/` contains all VDOMNode-based rendering. The `Tool` and `StaticTool` interfaces in `types.ts` with `renderSummary`/`renderPreview`/`renderDetail` are dead code — no class implements them. Tool execution returns `ToolInvocation` (`{ promise, abort }`), and rendering is done by standalone functions in `render-tools/`.
- **Some types already in core**: `ToolRequestId`, `ToolName`, `ToolRequest`, `ValidateInput` are in `node/core/src/tool-types.ts`. Provider types (`ProviderToolResult`, `ProviderToolSpec`, `AgentStreamingBlock`) are in core's providers.
- **Pure utilities already in core**: `assertUnreachable`, `Result`/`extendError`, `Defer`/`pollUntil`/`delay`, `Dispatch`, `ThreadType`/`ThreadId`, `Logger`.
- **3 tools are nvim-heavy**: `hover.ts`, `findReferences.ts`, `diagnostics.ts` directly call nvim/LSP APIs.
- **MCP client/manager** use nvim only for logging (already have `Logger` in core).
- **Several tools declare nvim in context but never use it**: `getFile.ts`, `edl.ts`, `thread-title.ts`.

## Remaining root-project imports in tools (non-test files)

| Import                           | Used in                                                     | What it is                                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../utils/files`                 | 9 files                                                     | `NvimCwd`, `HomeDir`, `AbsFilePath`, `RelFilePath`, `UnresolvedFilePath`, `DisplayPath`, `resolveFilePath`, etc. — pure types+functions, zero nvim deps |
| `../providers/*`                 | 16 files                                                    | Already in core (`@magenta/core`). Will become relative core imports.                                                                                   |
| `../utils/result`                | 11 files                                                    | Already in core                                                                                                                                         |
| `../utils/assertUnreachable`     | 6 files                                                     | Already in core                                                                                                                                         |
| `../tea/tea`                     | 3 files (create-tool, edl, getFile)                         | Only `Dispatch` type — already in core                                                                                                                  |
| `../tea/view`                    | 2 files (helpers, types)                                    | `VDOMNode`, `d`, `withCode` — nvim-specific rendering                                                                                                   |
| `../tea/util`                    | 2 files (hover, findReferences)                             | `calculateStringPosition` — pure function                                                                                                               |
| `../nvim/*`                      | 8 files                                                     | `Nvim`, `NvimBuffer`, position types — nvim-specific                                                                                                    |
| `../capabilities/lsp`            | 3 files (hover, findReferences, create-tool)                | `Lsp` class — nvim-dependent                                                                                                                            |
| `../capabilities/shell`          | 2 files (bashCommand, create-tool)                          | `Shell` interface — already pure                                                                                                                        |
| `../capabilities/thread-manager` | 4 files                                                     | `ThreadManager` interface — uses types already in core                                                                                                  |
| `../options`                     | 4 files (create-tool, bashCommand, mcp/manager, mcp/client) | `MagentaOptions`, `MCPServerConfig` — only uses `maxConcurrentSubagents` and `mcpServers`                                                               |
| `../chat/types`                  | 5 files                                                     | `ThreadId`, `ThreadType` — already in core                                                                                                              |
| `../chat/thread`                 | 2 files (create-tool, edl)                                  | `Msg as ThreadMsg` — used for dispatch                                                                                                                  |
| `../buffer-tracker`              | 2 files (create-tool, edl)                                  | `BufferTracker` class — nvim-specific                                                                                                                   |
| `../context/context-manager`     | 2 files (create-tool, getFile)                              | `ContextManager` class — nvim-specific                                                                                                                  |
| `../utils/buffers`               | 2 files (hover, findReferences)                             | `getOrOpenBuffer` — nvim-specific                                                                                                                       |
| `../utils/diagnostics`           | 1 file (diagnostics)                                        | `getDiagnostics` — nvim-specific                                                                                                                        |
| `../utils/pdf-pages`             | 1 file (getFile)                                            | PDF handling utility                                                                                                                                    |
| `../utils/file-summary`          | 1 file (getFile)                                            | File summarization utility                                                                                                                              |

## External npm deps used by tools

| Package                          | Used in                           |
| -------------------------------- | --------------------------------- |
| `ignore`                         | util.ts                           |
| `@modelcontextprotocol/sdk`      | mcp/client.ts, mcp/mock-server.ts |
| `openai` (just `JSONSchemaType`) | mcp/client.ts                     |
| `zod`                            | mcp/mock-server.ts                |

## Strategy

The tools migration is more complex than providers because tools interact with nvim for LSP, buffers, and diagnostics. The key insight is that **rendering is already separated** into `render-tools/`, so we only need to move execution logic.

**Category A — Already in core or trivially movable**:

- Types already in core: `ToolRequestId`, `ToolName`, `ToolRequest`, `ValidateInput`, `Dispatch`, `ThreadType`, `ThreadId`, `Result`, `assertUnreachable`, `Logger`
- Pure modules: `tool-registry.ts`, `mcp/types.ts`, `util.ts`, `helpers.ts` (validateInput + extractPartialJsonStringValue)
- `utils/files.ts` — all branded types and functions are pure, zero nvim deps

**Category B — Need interface extraction**:

- `Lsp` — define a minimal `LspClient` interface in core with the methods tools need

- `getDiagnostics` — define a `DiagnosticsProvider` interface in core
- `ContextManager` — define a minimal interface in core for what getFile needs
- `BufferTracker` — define a minimal interface in core for what edl needs
- `calculateStringPosition` from `tea/util` — pure function, move to core
- `pdf-pages`, `file-summary` — pure utilities, move to core
- MCP options: define `MCPServerConfig` type subset in core

**Category C — Stays in root**:

- `render-tools/` — all rendering stays in root (VDOMNode-dependent)
- `helpers.ts` `renderStreamdedTool` function — rendering, stays in root
- Dead `Tool`/`StaticTool` interfaces with render methods — remove

**Category D — Wiring that stays in root**:

- `create-tool.ts` — the factory that wires nvim instances into tool contexts. Stays in root and imports tool execute functions from `@magenta/core`.

## Relevant files

- `node/core/src/` — target location
- `node/core/package.json` — will need new npm deps
- `node/core/tsconfig.json` — will need new source files
- `node/tools/*.ts` — source files to move
- `node/tools/mcp/*.ts` — MCP files to move
- `node/render-tools/*.ts` — stays in root, imports updated to `@magenta/core`
- `node/utils/files.ts` — move to core
- `node/utils/pdf-pages.ts`, `node/utils/file-summary.ts` — move to core
- `node/tea/util.ts` — `calculateStringPosition` to move
- All root-project files that import from `node/tools/` — need import updates

# implementation

## Phase 1: Move `utils/files.ts` to core

All branded types and utility functions are pure with zero nvim deps. Many tools depend on these.

- [ ] Move `node/utils/files.ts` to `node/core/src/utils/files.ts`
  - Dependencies: `node:path`, `node:fs/promises`, `file-type`, `mime-types` npm packages
  - Add `file-type` and `mime-types` to `node/core/package.json` if not already there
  - Export key types from core index: `AbsFilePath`, `RelFilePath`, `UnresolvedFilePath`, `HomeDir`, `DisplayPath`, `NvimCwd`, `FileCategory`, `FileTypeInfo`, `MAGENTA_TEMP_DIR`, `resolveFilePath`, `relativePath`, `displayPath`, `expandTilde`, `detectFileType`, `isLikelyTextFile`, `categorizeFileType`, `validateFileSize`, `FILE_SIZE_LIMITS`
  - Note: core already exports `AbsFilePath` and `Cwd` from `paths.ts`. Reconcile: either merge into one module or have files.ts re-use `AbsFilePath` from `paths.ts`. The existing `Cwd` in core's `paths.ts` may correspond to `NvimCwd`. Unify these.
  - Update root's `node/utils/files.ts` to re-export from `@magenta/core`
  - Check for type errors with `npx tsgo -b`

## Phase 2: Move pure tool utilities to core

- [ ] Keep `node/tools/util.ts` in root (gitignore handling stays in root for now)
  - Update its imports of branded types to use `@magenta/core` once files.ts moves

- [ ] Move `node/tools/tool-registry.ts` to `node/core/src/tools/tool-registry.ts`
  - Pure constants, zero deps
  - Export from core index

- [ ] Move `node/tools/mcp/types.ts` to `node/core/src/tools/mcp/types.ts`
  - Only depends on `ToolName` (already in core)
  - Export from core index

- [ ] Move `calculateStringPosition` from `node/tea/util.ts` to `node/core/src/utils/string-position.ts`
  - Pure function, no deps
  - Update root's `node/tea/util.ts` to re-export from `@magenta/core`

- [ ] Move `node/utils/pdf-pages.ts` to `node/core/src/utils/pdf-pages.ts` (if pure)
  - Check deps first — if it's pure Node.js, move it
  - Export from core index

- [ ] Move `node/utils/file-summary.ts` to `node/core/src/utils/file-summary.ts` (if pure)
  - Check deps first — if it's pure Node.js, move it
  - Export from core index

- [ ] Check for type errors: `npx tsgo -b`
- [ ] Run tests: `npx vitest run`

## Phase 3: Define capability interfaces in core

These interfaces abstract nvim-dependent functionality so tool implementations can use them.

- [ ] Create `node/core/src/capabilities/lsp-client.ts` — minimal LSP interface for tools
  - Define types: `LspRange`, `LspPosition`, `LspHoverResponse`, `LspReferencesResponse`, `LspDefinitionResponse`
  - Define interface `LspClient` with methods:
    - `requestHover(filePath: AbsFilePath, position: {line: number, character: number}): Promise<LspHoverResponse>`
    - `requestReferences(filePath: AbsFilePath, position: {line: number, character: number}): Promise<LspReferencesResponse>`
    - `requestDefinition(filePath: AbsFilePath, position: {line: number, character: number}): Promise<LspDefinitionResponse>`
    - `requestTypeDefinition(filePath: AbsFilePath, position: {line: number, character: number}): Promise<LspDefinitionResponse>`
  - Note: The current Lsp class takes `NvimBuffer` + `PositionString`. The core interface should use file paths + position objects instead, and the root-project adapter converts to nvim-specific types.
  - Export from core index

- [ ] Create `node/core/src/capabilities/diagnostics-provider.ts`
  - Define interface `DiagnosticsProvider` with:
    - `getDiagnostics(): Promise<string>`
  - Export from core index

- [ ] Create `node/core/src/capabilities/context-tracker.ts` — minimal interface for what getFile needs from ContextManager
  - Check what getFile actually uses from ContextManager (likely `addFileContext` or similar)
  - Define minimal interface
  - Export from core index

- [ ] Drop `BufferTracker` from edl's context — it's declared but never accessed

- [ ] Move `Shell` interface to core: `node/core/src/capabilities/shell.ts`
  - `Shell`, `ShellResult`, `OutputLine` are already pure interfaces with zero nvim deps
  - Export from core index
  - Update root's `node/capabilities/shell.ts` to re-export from `@magenta/core`

- [ ] Move `ThreadManager` interface to core: `node/core/src/capabilities/thread-manager.ts`
  - Already uses types that are in core (`ThreadId`, `ThreadType`, `UnresolvedFilePath`, `Result`)
  - Export from core index
  - Update root's `node/capabilities/thread-manager.ts` to re-export from `@magenta/core`

- [ ] Define MCP options types in core
  - Create `node/core/src/tools/mcp/options.ts` with `MCPServerConfig` and related types
  - Tools only need: server type (stdio/sse/http), connection params, tool config
  - Export from core index

- [ ] Check for type errors: `npx tsgo -b`

## Phase 4: Clean up tool types

- [ ] Remove dead `Tool` and `StaticTool` interfaces from `node/tools/types.ts`
  - These have `renderSummary(): VDOMNode` etc. but nothing implements them
  - Confirm with `find_references` that they're truly unused before removing

- [ ] Remove `VDOMNode` import from `node/tools/types.ts` (becomes unnecessary after removing dead interfaces)

- [ ] Move remaining types from `node/tools/types.ts` to core's `node/core/src/tool-types.ts`
  - `GenericToolRequest`, `DisplayContext`, `CompletedToolInfo`, `ToolInvocation`, `ToolManagerToolMsg`, `ToolMsg`
  - Some of these reference `ProviderToolResult` which is already in core
  - Export from core index

- [ ] Check for type errors: `npx tsgo -b`

## Phase 5: Move tool validation and spec functions to core

Each tool has `validateInput` and `getSpec` functions that are pure.

- [ ] Move individual tool validateInput/getSpec to core, one file at a time
  - For each tool, the validate/spec parts have no nvim deps
  - Can create `node/core/src/tools/<toolName>.ts` with just the spec/validation, then move execution in Phase 6

- [ ] Move `helpers.ts` functions to core (except `renderStreamdedTool`)
  - `validateInput` dispatcher — move to core
  - `extractPartialJsonStringValue` — pure, move to core
  - `renderStreamdedTool` — stays in root (uses VDOMNode, `d` template)
  - Split the file: core gets the pure parts, root keeps rendering

- [ ] Move `toolManager.ts` to core: `node/core/src/tools/toolManager.ts`
  - Only deps: `assertUnreachable` (core), `ProviderToolSpec` (core), `ThreadId`/`ThreadType` (core), tool specs from individual tools, `MCPToolManager`
  - All these will be in core after MCP moves

- [ ] Check for type errors: `npx tsgo -b`

## Phase 6: Move tool execution files to core

- [ ] Move nvim-free tools first (easiest):
  - `yield-to-parent.ts` — only uses `Result` and provider types (all in core)
  - `thread-title.ts` — declares nvim but doesn't use it; remove unused nvim from context
  - `spawn-subagent.ts` — uses `ThreadManager` (will be in core), `Result`, provider types
  - `spawn-foreach.ts` — uses `ThreadManager`, `Result`, provider types
  - `wait-for-subagents.ts` — uses `ThreadManager`, `Result`, provider types
  - `bashCommand.ts` — uses `Shell` (will be in core), `Result`
  - `getFile.ts` — declares nvim but doesn't use it; uses `FileIO` (core), `ContextManager` interface (core after Phase 3)
  - `edl.ts` — declares nvim and bufferTracker but uses neither; uses `EdlRegisters`/`FileIO` (core). Drop unused context fields.
  - Update imports to use relative core paths
  - Remove unused `nvim` from context types where declared but not used

- [ ] Move nvim-dependent tools (with capability interfaces):
  - `hover.ts` — refactor to use `LspClient` interface instead of direct nvim/Lsp/NvimBuffer
  - `findReferences.ts` — refactor to use `LspClient` interface
  - `diagnostics.ts` — refactor to use `DiagnosticsProvider` interface
  - Each tool's execute function receives the interface instead of raw nvim objects

- [ ] Move MCP files:
  - `mcp/client.ts` — replace `Nvim` with `Logger` (already in core), use `MCPServerConfig` from core
  - `mcp/manager.ts` — replace `Nvim` with `Logger`, use core option types
  - `mcp/tool.ts` — only uses `ProviderToolResult` (already in core)
  - `mcp/mock-server.ts` — uses `Defer`/`pollUntil` (core), `assertUnreachable` (core), option types

- [ ] Move `create-tool.ts` to core
  - This is the wiring factory. It will need to accept all capability interfaces.
  - Define `CreateToolContext` with interfaces from core instead of concrete nvim types
  - The root project creates the concrete context by wrapping nvim objects in the interfaces

- [ ] Check for type errors: `npx tsgo -b`
- [ ] Run tests: `npx vitest run`

## Phase 7: Update root-project imports

- [ ] Update all root-project files to import from `@magenta/core` instead of `./tools/` or `../tools/`
  - `node/chat/chat.ts` — MCPToolManager
  - `node/chat/thread.ts` — ToolManager, tool types, helpers
  - `node/render-tools/*.ts` — tool types, progress types
  - `node/options.ts` — ServerName, validateServerName
  - `node/test/preamble.ts` — MockMCPServer, ServerName
  - Test files — ToolRequestId, ToolName, etc.
  - `node/magenta.test.ts`, `node/chat/*.test.ts`, `node/context/context-manager.test.ts`

- [ ] Update render-tools to import progress types from `@magenta/core`
  - BashProgress, SpawnSubagentProgress, WaitForSubagentsProgress, MCPProgress, EdlDisplayData, ThreadTitleProgress
  - These are tool execution state types, not rendering types

- [ ] Split `node/tools/helpers.ts`
  - `renderStreamdedTool` stays in root (e.g. `node/render-tools/streaming.ts`)
  - `validateInput` and `extractPartialJsonStringValue` are in core

- [ ] Create adapter implementations in root for the capability interfaces
  - `LspClient` adapter wrapping the nvim `Lsp` class
  - `DiagnosticsProvider` adapter wrapping `getDiagnostics(nvim, ...)`

  - These go in `node/capabilities/` as adapters

- [ ] Check for type errors: `npx tsgo -b`

## Phase 8: Move test files

- [ ] Move tool test files to `node/core/src/tools/`
  - Tests that are purely about validation/specs can move directly
  - Tests that need nvim (integration tests) may need the mock driver or stay in root

- [ ] Check for type errors: `npx tsgo -b`
- [ ] Run tests: `npx vitest run`

## Phase 9: Final cleanup

- [ ] Remove re-export shims from root `node/tools/` that are no longer needed
- [ ] Verify no circular dependencies: core should not import from root
  - Run `npx tsgo -b` clean
- [ ] Remove old `node/tools/` directory if fully emptied
- [ ] Update `node/core/src/tool-types.ts` — may merge with `node/core/src/tools/types.ts`
- [ ] Clean up `node/core/src/index.ts` exports for the new tool modules
- [ ] Run full test suite: `npx vitest run`
- [ ] Update context.md migration status
