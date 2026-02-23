# context

The goal is to split the node code into two npm workspace packages with TypeScript project references, so that the "core" package (tools, providers, agent loop, etc.) has no dependency on neovim and can eventually run as an independent process.

Currently everything lives under `node/` with a single `tsconfig.json` and `package.json` at the root.

## Goal organization (phase 1 - scaffolding)

Create `node/core/` as a workspace. Existing code stays in place under `node/`. The root serves as both workspace root and the "plugin" side for now.

```
magenta.nvim/
  lua/                          # unchanged
  node/
    core/                       # @magenta/core workspace
      package.json              # standalone deps only (anthropic, zod, etc.)
      tsconfig.json             # composite: true, declaration: true
      src/
        index.ts                # entry point, exports grow as modules move in
    # everything else stays where it is
    magenta.ts
    sidebar.ts
    tea/
    tools/
    providers/
    ...
  package.json                  # workspace root: workspaces: ["node/core"]
  tsconfig.json                 # references: ["node/core"], excludes node/core/**
  vitest.config.ts              # unchanged
```

### npm layer

- Root `package.json` gains `workspaces: ["node/core"]`
- `node/core/package.json` (`@magenta/core`): starts with no deps, gains them as modules move in
- npm symlinks `node_modules/@magenta/core` → `node/core/`

### TypeScript layer

- `node/core/tsconfig.json`: `composite: true`, `declaration: true`, includes `src/**/*`
- Root `tsconfig.json`: gains `references: [{ "path": "node/core" }]`, excludes `node/core/**`
- Root still uses `tsgo --noEmit` for now; can switch to `tsgo -b` later

### Future phases

- Phase 2: Incrementally move modules into `node/core/src/` (bottom-up from leaf deps)
- Phase 3: Formalize the neovim side into `node/plugin/` as a second workspace
- Phase 4: Make core an independent process with IPC boundary

# implementation

- [x] Step 1: Create core workspace scaffolding
  - [x] Create `node/core/package.json` with name `@magenta/core`
  - [x] Create `node/core/tsconfig.json` with `composite: true`, `declaration: true`
  - [x] Create `node/core/src/index.ts` placeholder entry point
  - [x] Add `workspaces: ["node/core"]` to root `package.json`
  - [x] Add `references` and `exclude` for `node/core/**` to root `tsconfig.json`
  - [x] Run `npm install` — verify symlink at `node_modules/@magenta/core`
  - [x] Verify `tsgo --noEmit` passes on root project
  - [x] Verify `tsgo -p node/core/tsconfig.json --noEmit` passes on core project
  - [x] Verify tests still pass (1 pre-existing snapshot ordering flake, unrelated)

- [ ] Step 2: Move a leaf module into core (future)
  - [ ] Pick a module with no nvim deps (e.g. `edl/` or `utils/`)
  - [ ] Move it into `node/core/src/`
  - [ ] Move its deps from root `package.json` into `node/core/package.json`
  - [ ] Update imports in root code to use `@magenta/core`
  - [ ] Verify type-checking + tests pass
