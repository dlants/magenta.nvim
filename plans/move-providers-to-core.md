# context

The goal is to physically move `node/providers/` into `node/core/src/providers/` so it becomes part of the `@magenta/core` package.

The previous plan (`migrate-providers-to-core.md`) removed all direct nvim dependencies from the providers directory. What remains are dependencies on other root-project modules that need to be resolved.

## Remaining root-project imports in providers (non-test files)

| Import                       | Used in                                                                       | What it is                                                             |
| ---------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `../utils/assertUnreachable` | anthropic.ts, anthropic-agent.ts, provider.ts, system-prompt.ts               | Pure function, zero deps                                               |
| `../utils/result`            | anthropic.ts, mock.ts, provider-types.ts                                      | `Result<T>` type + `extendError`, zero deps                            |
| `../utils/async`             | mock.ts, mock-anthropic-client.ts                                             | `Defer`, `pollUntil`, zero deps                                        |
| `../tea/tea`                 | anthropic-agent.ts, anthropic.ts, mock.ts, provider-types.ts                  | Only `Dispatch<Msg>` type = `(msg: Msg) => void`, zero deps            |
| `../tools/toolManager`       | provider-types.ts                                                             | Only `ToolRequestId` (branded string), re-exported from tools/types.ts |
| `../tools/types`             | anthropic-agent.ts, anthropic.ts, mock-anthropic-client.ts, provider-types.ts | `ToolName`, `ToolRequest`, `ToolRequestId` — branded types             |
| `../tools/helpers`           | anthropic-agent.ts, anthropic.ts                                              | `validateInput` — dispatches to each tool module, deeply entangled     |
| `../auth/anthropic`          | anthropic.ts                                                                  | OAuth helpers, deps: `@openauthjs/openauth/pkce`, fs, path, os         |
| `../options`                 | provider.ts, skills.ts, system-prompt.ts                                      | `Profile`, `MagentaOptions` types — large, many sub-types              |
| `../chat/types`              | system-prompt.ts, system-reminders.ts                                         | `ThreadType` — simple string union, zero deps                          |

## External npm deps used by providers

| Package                          | Used in                                             |
| -------------------------------- | --------------------------------------------------- |
| `@anthropic-ai/sdk`              | anthropic.ts, anthropic-agent.ts, provider-types.ts |
| `@anthropic-ai/bedrock-sdk`      | bedrock.ts                                          |
| `openai` (just `JSONSchemaType`) | provider-types.ts                                   |
| `yaml`                           | skills.ts                                           |
| `@openauthjs/openauth`           | auth/anthropic.ts (imported by anthropic.ts)        |

## Strategy

There are two categories of deps to resolve:

**Category A — Trivially movable to core** (zero deps, pure types/utilities):

- `assertUnreachable`, `Result`/`extendError`, `Defer`/`pollUntil`/`delay`, `Dispatch`, `ToolRequestId`, `ToolName`, `ToolRequest`, `ThreadType`/`ThreadId`

**Category B — Need interface extraction or kept as injection**:

- `validateInput` — deeply coupled to tool implementations. Provider should receive a validation function rather than importing it.
- `MagentaOptions` / `Profile` — large types with many sub-types. Providers only use a subset of fields. Define minimal interfaces in core for what providers need.
- `auth/anthropic` — OAuth token management. Has one npm dep (`@openauthjs/openauth`). Could move to core if we add the npm dep there, or stay in root and be injected.

## Relevant files

- `node/core/src/` — target location
- `node/core/package.json` — will need new dependencies
- `node/core/tsconfig.json` — will need new source files
- `node/providers/*.ts` — source files to move
- `node/utils/assertUnreachable.ts`, `node/utils/result.ts`, `node/utils/async.ts` — utilities to move
- `node/chat/types.ts` — types to move or duplicate
- All root-project files that import from `node/providers/` — need to update to `@magenta/core`

# implementation

## Phase 1: Move pure utilities to core

- [x] Move `assertUnreachable` to `node/core/src/utils/assertUnreachable.ts`
  - Copy the function, export from core index
  - Update root's `node/utils/assertUnreachable.ts` to re-export from `@magenta/core`
  - Check for type errors

- [x] Move `Result` type and `extendError` to `node/core/src/utils/result.ts`
  - Copy the module, export from core index
  - Update root's `node/utils/result.ts` to re-export from `@magenta/core`
  - Check for type errors

- [x] Move `Defer`, `pollUntil`, `delay`, `withTimeout` to `node/core/src/utils/async.ts`
  - Copy the module, export from core index
  - Update root's `node/utils/async.ts` to re-export from `@magenta/core`
  - Check for type errors

- [x] Move `Dispatch` type to `node/core/src/dispatch.ts`
  - Define `type Dispatch<Msg> = (msg: Msg) => void`
  - Export from core index
  - Update root's `node/tea/tea.ts` to re-export `Dispatch` from `@magenta/core`
  - Check for type errors

- [x] Move tool branded types to `node/core/src/tool-types.ts`
  - `ToolRequestId`, `ToolName`, `ToolRequest`
  - Export from core index
  - Update root's `node/tools/types.ts` and `node/tools/toolManager.ts` to re-export from `@magenta/core`
  - Check for type errors

- [x] Move `ThreadType` (and related: `ThreadId`, `Role`, `MessageIdx`) to `node/core/src/chat-types.ts`
  - Export from core index
  - Update root's `node/chat/types.ts` to re-export from `@magenta/core`
  - Check for type errors

- [x] Run tests to validate Phase 1: `npx vitest run`

## Phase 2: Define minimal provider-facing interfaces for options

- [x] Create `node/core/src/provider-options.ts` with minimal interfaces
  - `ProviderProfile`: subset of `Profile` used by providers (name, provider, model, fastModel, baseUrl, apiKeyEnvVar, authType, thinking, reasoning, env, promptCaching)
  - `ProviderOptions`: subset of `MagentaOptions` used by providers (skillsPaths, plus any other fields used in skills.ts/system-prompt.ts)
  - Export from core index
  - Check for type errors

- [x] Update providers to use the new minimal interfaces instead of `MagentaOptions` and `Profile`
  - Update `provider.ts`, `skills.ts`, `system-prompt.ts`
  - Verify root-project `MagentaOptions` and `Profile` satisfy these interfaces (so they can be passed without casting)
  - Check for type errors

## Phase 3: Extract `validateInput` dependency

- [x] Change `validateInput` usage in providers to an injected function
  - In `provider-types.ts` or a new core file, define a type: `type ValidateInput = (toolName: ToolName, input: unknown) => Result<Record<string, unknown>>`
  - Pass it as a parameter to `AnthropicProvider`/`AnthropicAgent` rather than importing from `../tools/helpers`
  - The root project creates the concrete `validateInput` and passes it in
  - Check for type errors

## Phase 4: Abstract auth module dependency

- [x] Define an `AnthropicAuth` interface in core that `anthropic.ts` can call
  - Methods needed: `isAuthenticated(): Promise<boolean>`, `authorize(): Promise<{url: string, verifier: string}>`, `exchange(code: string, verifier: string): Promise<tokens>`, `storeTokens(tokens): Promise<void>`, `getAccessToken(): Promise<string | undefined>`
  - `auth/anthropic.ts` stays in root and implements this interface
  - `AnthropicProvider` receives the auth implementation as a constructor dependency
  - Check for type errors

## Phase 5: Add npm dependencies to core

- [x] Add npm dependencies that providers need to `node/core/package.json`
  - `@anthropic-ai/sdk`
  - `@anthropic-ai/bedrock-sdk`
  - `openai` (or just copy the `JSONSchemaType` — it's a simple type)
  - `yaml`

  - Run `npm install` from project root
  - Check for type errors

## Phase 6: Move provider files

- [x] Move all provider source files to `node/core/src/providers/`
  - `provider-types.ts`, `anthropic.ts`, `anthropic-agent.ts`, `bedrock.ts`, `provider.ts`, `system-prompt.ts`, `system-reminders.ts`, `skills.ts`, `mock.ts`, `mock-anthropic-client.ts`
  - Move `prompts/` subdirectory as well
  - Update all internal imports to use relative core paths
  - Export key types and functions from core index
  - Check for type errors

- [x] Update all root-project imports to use `@magenta/core`
  - Find all files importing from `./providers/` or `../providers/`
  - Update to import from `@magenta/core`
  - Check for type errors

- [x] Move provider test files to `node/core/src/providers/`
  - `anthropic-agent.test.ts`, `skills.test.ts`, `system-prompt.test.ts`
  - Tests that need nvim (`skills.test.ts`, `system-prompt.test.ts`) may stay in root or use mock logger
  - Check for type errors

## Phase 7: Final verification

- [x] Verify no circular dependencies between core and root
  - Core should not import from root project
  - Run `npx tsgo -b`
- [x] Run full test suite: `npx vitest run`
- [x] Clean up any re-export shims that are no longer needed
