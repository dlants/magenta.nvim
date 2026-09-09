// Bootstrap script loaded via `node --import ./node/nvimclient/boot.mjs` before the
// main entry file (index.ts). This runs AFTER node itself is up but BEFORE
// the TypeScript entry file and all of its transitive imports are loaded
// and transformed by --experimental-transform-types.
//
// We stash a timestamp on globalThis so index.ts can pick it up and report
// it as part of the unified timing summary.
globalThis.__MAGENTA_BOOT_MS__ = Date.now();
