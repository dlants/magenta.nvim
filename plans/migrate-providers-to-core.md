# context

The goal is to prepare `node/providers/` for migration to `@magenta/core` by removing all nvim-specific dependencies.

## Current nvim dependencies in providers

There are two categories of nvim dependency:

### 1. `Nvim` type (from `../nvim/nvim-node`)

Imported in 6 files: `anthropic.ts`, `bedrock.ts`, `provider.ts`, `system-prompt.ts`, `skills.ts`, `openai.test.ts`.

Actual usage patterns:

- **Logging** (`nvim.logger.info/warn/error`): `anthropic.ts`, `skills.ts` — this is the most common use. The logger is a `winston.Logger`.
- **OAuth UI** (`nvim.call("nvim_exec_lua", ...)`): `anthropic.ts:168` — shows a floating window with instructions and gets user input for the OAuth auth code. Genuinely nvim-specific.
- **System info** (`nvim.call("nvim_eval", ["v:version"])`): `system-prompt.ts:25` — fetches neovim version string for the system prompt. Nvim-specific info that should be injected.
- **Pass-through only** (no direct access): `provider.ts`, `bedrock.ts` — just forward `nvim` to constructors.
- **Test helper**: `openai.test.ts` imports `withNvimClient` from test preamble.

### 2. `NvimCwd` type (from `../utils/files`)

Imported in 2 files: `system-prompt.ts`, `skills.ts`.

`NvimCwd` is defined as `AbsFilePath & { __nvim_cwd: true }`. It's used for:

- Resolving relative skill directory paths (`skills.ts:96`)
- Computing display paths with `path.relative()` (`skills.ts:222`)
- Stored in `SystemInfo` and interpolated into the system prompt (`system-prompt.ts`)

`AbsFilePath` is also used directly in `skills.ts` for skill file paths.

## Relevant files

- `node/providers/anthropic.ts`: Main provider, has OAuth + logging deps
- `node/providers/bedrock.ts`: Extends AnthropicProvider, pass-through only
- `node/providers/provider.ts`: Factory function, pass-through only
- `node/providers/system-prompt.ts`: Builds system prompt, needs nvim version + cwd
- `node/providers/skills.ts`: Loads skill files, needs logger + cwd + AbsFilePath
- `node/providers/provider-types.ts`: Provider interface (no nvim deps)
- `node/utils/files.ts`: Defines `AbsFilePath`, `NvimCwd`
- `node/nvim/nvim-node/types.ts`: Defines `Nvim` type with `logger: winston.Logger`
- `node/core/src/capabilities/file-io.ts`: Existing core capability pattern

## Key types to introduce in core

- `Logger` interface: `{ info(...args: unknown[]): void; warn(...args: unknown[]): void; error(...args: unknown[]): void; debug(...args: unknown[]): void }`
- `Cwd` branded type: `AbsFilePath & { __cwd: true }` (replaces `NvimCwd`)
- `AbsFilePath` branded type: `string & { __abs_file_path: true }` (move from utils/files)

# implementation

- [x] Create `node/core/src/logger.ts` with a `Logger` interface
  - Only needs `info`, `warn`, `error`, `debug` methods (subset of winston.Logger)
  - Export from `node/core/src/index.ts`
  - Check for type errors

- [x] Create `node/core/src/paths.ts` with `AbsFilePath` and `Cwd` branded types
  - `AbsFilePath = string & { __abs_file_path: true }`
  - `Cwd = AbsFilePath & { __cwd: true }`
  - Export from `node/core/src/index.ts`
  - Check for type errors

- [x] Update `node/utils/files.ts` to import `AbsFilePath` from core and re-export it
  - Change `NvimCwd` to extend core `Cwd` (so NvimCwd is assignable to Cwd)
  - Update all root-project references as needed
  - Check for type errors and iterate

- [x] Abstract the OAuth UI interaction out of `anthropic.ts`
  - Define an `AuthUI` interface in core with `showOAuthFlow(authUrl: string): Promise<string>`
  - `AnthropicProvider` constructor accepts an `AuthUI` dependency instead of `Nvim`
  - The nvim-specific implementation (floating window + `vim.fn.input`) stays in root project and is passed into the provider at construction time
  - Check for type errors and iterate

- [x] Abstract system info gathering in `system-prompt.ts`
  - Change `getSystemInfo` to accept a `SystemInfo` object (or the pieces it needs) rather than calling `nvim.call` itself
  - The caller (in root project) is responsible for fetching neovim version and passing it in
  - Replace `NvimCwd` with `Cwd` in the `SystemInfo` type
  - Check for type errors and iterate

- [x] Replace `Nvim` with `Logger` in `skills.ts`
  - Change context type from `{ nvim: Nvim; cwd: NvimCwd }` to `{ logger: Logger; cwd: Cwd }`
  - Replace `NvimCwd` with `Cwd`, `AbsFilePath` with core's `AbsFilePath`
  - Check for type errors and iterate

- [x] Replace `Nvim` with `Logger` in `anthropic.ts` and `bedrock.ts`
  - Constructor takes `{ logger: Logger; authUI: AuthUI }` (or similar) instead of `Nvim`
  - Replace all `this.nvim.logger.*` calls with `this.logger.*`
  - Check for type errors and iterate

- [x] Update `provider.ts` factory
  - Change `getProvider` signature: replace `nvim: Nvim` with the new deps (`logger`, `authUI`, etc.)
  - Update all callers of `getProvider` in the root project
  - Check for type errors and iterate

- [x] Clean up commented-out nvim imports in `ollama.ts`, `copilot.ts`, `openai.ts`, `copilot.test.ts`

- [x] Update tests (`openai.test.ts`, `skills.test.ts`, `system-prompt.test.ts`, etc.)
  - Replace `withNvimClient` usage with mock logger/deps where possible
  - Check for type errors and iterate, run tests

- [x] Final check: verify no file in `node/providers/` imports from `../nvim/`
  - `rg "nvim" node/providers/` should show no imports from nvim-node or utils/files NvimCwd
  - Run full type check with `npx tsgo -b`
  - Run tests with `npx vitest run node/providers/`
