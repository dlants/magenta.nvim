# Migrating to tsgo (TypeScript 7 native compiler)

## Status: ✅ Already works!

`npx tsgo --noEmit` passes with zero errors on the current codebase. Timing: ~0.48s (tsgo) vs ~2.45s (tsc), a ~5x speedup.

## Background

Microsoft is porting the TypeScript compiler from JS to Go ("Project Corsa"). The native preview is available as `@typescript/native-preview` which provides a `tsgo` CLI. TypeScript 6.0 just entered beta (Feb 2026) as a bridge release, and TypeScript 7.0 (the Go-based compiler) is targeting mid/late 2026 for release.

## Current project compatibility

Our tsconfig settings are very tsgo-friendly:

- `target: "ESNext"` — no downlevel emit needed (tsgo only supports down to es2021)
- `module: "ESNext"` + `moduleResolution: "bundler"` — fully supported
- `noEmit: true` — we don't use tsc for emit at all (we use `tsx` at runtime)
- `strict: true` — tsgo will default to strict, so we're already aligned
- No decorators, no namespaces — these are areas with tsgo gaps

### Minor concerns

1. **Enums**: We use two `enum` declarations (`FileCategory` in `node/utils/files.ts` and `MessageType` in `node/nvim/nvim-node/types.ts`). TypeScript 7 will continue to support enums, but Node.js type-stripping (if we move to that in the future) cannot handle enums since they're not "erasable" syntax. Not a tsgo issue per se, but worth noting.

2. **`allowImportingTsExtensions`**: Supported by tsgo since it respects tsconfig the same way.

3. **`verbatimModuleSyntax`**: Supported.

4. **`exactOptionalPropertyTypes`**: Supported.

## Migration steps

### Phase 1: Use tsgo for type-checking (can do now)

- [x] Install `@typescript/native-preview` as devDependency
- [x] Verify `npx tsgo --noEmit` passes with zero errors
- [~] ~~Add a `typecheck` script to package.json~~ (not needed)
- [x] Update `context.md` to reference `tsgo` instead of `tsc` for type checking
- [x] Update pre-commit hooks if they run tsc

### Phase 2: Keep tsc as fallback (current state)

- Keep `typescript` package installed for now — `tsx` depends on it at runtime, and tooling (eslint, vitest) may still reference it
- Run both `tsgo` and `tsc` in CI if desired, to cross-validate

### Phase 3: Full transition (when TS 7.0 releases, ~mid 2026)

- Replace `typescript` devDependency with the TS 7.0 package
- Update any tooling that depends on the tsc API (eslint plugins, etc.)
- Monitor ecosystem readiness of `typescript-eslint`, `vitest`, etc.

## No-op changes (things that just work)

- `tsx` runtime: unaffected — it uses esbuild for transpilation, not tsc
- vitest: unaffected — uses vite/esbuild internally
- eslint: unaffected — `typescript-eslint` currently uses the TS JS API, but this is independent of which CLI you use for type-checking
