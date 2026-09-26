import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

/** Our own layers return `Task` handles; only leaves wrapping an external
 * signal-based API may listen for aborts. */
const ALLOWED = new Set([
  "providers/codex-auth.ts",
  "providers/inference-shared.ts",
  "providers/mock-anthropic-client.ts",
  "utils/async.ts",
]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

it("only leaf wrappers listen for abort events", () => {
  const root = import.meta.dirname;
  const offenders = sources(root)
    .filter((path) =>
      readFileSync(path, "utf8").includes('addEventListener("abort"'),
    )
    .map((path) => relative(root, path))
    .filter((path) => !ALLOWED.has(path));
  expect(offenders).toEqual([]);
});
