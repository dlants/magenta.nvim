#!/usr/bin/env node
// Bundle magenta into a single ESM file + copy runtime assets.
// The bundle resolves `import.meta.url` to `dist/magenta.mjs`, so every
// file that's read via `dirname(fileURLToPath(import.meta.url))` expects
// its asset at a path relative to `dist/`.

import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

const banner =
  "import { createRequire as __createRequire } from 'module'; " +
  "const require = __createRequire(import.meta.url);";

const externals = [
  "@napi-rs/canvas",
  "@napi-rs/canvas-darwin-arm64",
  "@msgpackr-extract/*",
  "fsevents",
];

const cmd = [
  "esbuild",
  "node/index.ts",
  "--bundle",
  "--platform=node",
  "--format=esm",
  `--outfile=${join("dist", "magenta.mjs")}`,
  `--banner:js=${JSON.stringify(banner)}`,
  ...externals.map((e) => `--external:${e}`),
].join(" ");

console.log(`> ${cmd}`);
execSync(cmd, { stdio: "inherit", cwd: root });

// Copy runtime assets that get read via import.meta.url at runtime.
// In the bundle, import.meta.url is dist/magenta.mjs, so:
//   - edl.ts, spawn-subagents.ts (in node/core/src/tools/) -> dist/*.md
//   - compaction-manager.ts (in node/core/src/)            -> dist/*.md
//   - options.ts BUILTIN_AGENTS_PATH (__dirname + "core/src/agents")
//                                                          -> dist/core/src/agents/*.md
const assetCopies = [
  ["node/core/src/tools/edl-description.md", "dist/edl-description.md"],
  [
    "node/core/src/tools/spawn-subagents-description.md",
    "dist/spawn-subagents-description.md",
  ],
  [
    "node/core/src/compaction/compact-system-prompt.md",
    "dist/compact-system-prompt.md",
  ],
  ["node/chat/logo.txt", "dist/logo.txt"],
];

for (const [src, dst] of assetCopies) {
  mkdirSync(dirname(join(root, dst)), { recursive: true });
  copyFileSync(join(root, src), join(root, dst));
}

const agentsSrc = join(root, "node/core/src/agents");
const agentsDst = join(dist, "core/src/agents");
mkdirSync(agentsDst, { recursive: true });
for (const entry of readdirSync(agentsSrc)) {
  if (entry.endsWith(".md")) {
    copyFileSync(join(agentsSrc, entry), join(agentsDst, entry));
  }
}

console.log("bundle + assets written to dist/");
