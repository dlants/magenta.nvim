# Speed Up Startup

## Problem

When neovim starts, magenta takes a long time to become available. Until it does, `<leader>mt` gives:
`E492: Not an editor command: Magenta toggle`

The `Magenta` command is only registered when the node process starts and calls back into lua via `bridge()`.

## Root Cause

The start script is `npx tsx node/index.ts`. `tsx` is a TypeScript runtime that transpiles on the fly, adding significant startup latency. `npx` also adds overhead resolving the binary.

## Solution: Use Node's native type stripping

Node 24 can run TypeScript directly by stripping types. Use `node --experimental-transform-types node/index.ts` instead of `npx tsx node/index.ts`.

### Required changes

1. **Convert 2 enums to objects + type unions** (Node's type stripping doesn't support TS enums without `--experimental-transform-types`, but even with that flag it's better to eliminate them for forward compatibility):
   - `node/nvim/nvim-node/types.ts`: `MessageType` enum → const object
   - `node/utils/files.ts`: `FileCategory` enum → const object

2. **Add `.ts` extensions to all relative imports** (~100 files). Node's ESM requires explicit file extensions. The codebase uses `moduleResolution: "bundler"` which allows extensionless imports, but Node's resolver does not.
   - Regular imports: `from "./foo"` → `from "./foo.ts"`
   - Directory imports: `from "./nvim/nvim-node"` → `from "./nvim/nvim-node/index.ts"`
   - Type-level `import()` expressions: `import("../../nvim/nvim-node").Nvim` → `import("../../nvim/nvim-node/index.ts").Nvim`
   - Also applies to `node/core/` (2 imports)

3. **Update `package.json` start script**: `"start": "node --experimental-transform-types node/index.ts"`

4. **Update `tsconfig.json`**: change `moduleResolution` from `"bundler"` to `"nodenext"` (and `module` to `"nodenext"`) so TypeScript enforces explicit extensions going forward, preventing regressions. Same for `node/core/tsconfig.json`.
   - Note: `nodenext` module resolution requires explicit extensions AND requires `type` imports to use `import type` (already enforced by `verbatimModuleSyntax`).

5. **Verify**: run `npx tsgo -b` for type-checking and `npx vitest run` for tests.
