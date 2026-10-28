import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

/** The agent runtime has no working directory: the directory a thread was
 * started from is preparation-time information only. spawn_subagents is the
 * exception because it hands a directory to the session for a new thread. */
const CONFINED = ["tools", "edl", "supervisors", "thread-core.ts"];
const ALLOWED = new Set(["tools/spawn-subagents.ts"]);
const FORBIDDEN = /\b(?:ProjectDir|projectDir|Cwd|cwd)\b/;

function sources(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    if (statSync(child).isDirectory()) return sources(child);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [child] : [];
  });
}

it("the agent runtime does not reference a project or working directory", () => {
  const root = import.meta.dirname;
  const files = CONFINED.flatMap((p) => sources(join(root, p)));
  expect(files.length).toBeGreaterThan(20);
  const offenders = files
    .map((path) => relative(root, path))
    .filter(
      (path) =>
        !ALLOWED.has(path) &&
        FORBIDDEN.test(readFileSync(join(root, path), "utf8")),
    );
  expect(offenders).toEqual([]);
});
