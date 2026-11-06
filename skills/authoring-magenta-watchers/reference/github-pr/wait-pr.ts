/**
 * CLI: wait until a GitHub PR watched by this watcher reaches a condition.
 *   node --experimental-transform-types wait-pr.ts <pr-url> --until checks-done|green|new-failure|new-comment [--timeout S]
 * Prints the matching context and exits 0; exits 2 on timeout, 1 on error.
 * Predicates parse the `render` output in pull-request.ts (check lines
 * `- name: status url`, comment headers `### ...` followed by the comment url).
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WaitTimeoutError,
  watchUntil,
} from "../../../../sdk/watchers/client.ts";
import type { ResourceState } from "../../../../sdk/watchers/protocol.ts";

export type Until = "checks-done" | "green" | "new-failure" | "new-comment";

function section(context: string, header: string): string[] {
  const lines = context.split("\n");
  const start = lines.indexOf(header);
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line === "") break;
    out.push(line);
  }
  return out;
}

export function checks(context: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of section(context, "Checks:")) {
    const m =
      /^- (.*): (pending|success|failure|neutral|skipped)(?: \S+)?$/.exec(line);
    if (m?.[1] && m[2]) result.set(m[1], m[2]);
  }
  return result;
}

export function commentIds(context: string): Set<string> {
  const lines = context.split("\n");
  const ids = new Set<string>();
  lines.forEach((line, i) => {
    if (line.startsWith("### ")) ids.add(lines[i + 1] || line);
  });
  return ids;
}

export function hasContext(s: ResourceState): boolean {
  return (s.status === "active" || s.status === "finished") && !!s.context;
}

export function makePredicate(
  until: Until,
  initial: string,
): (context: string) => boolean {
  if (until === "checks-done") {
    return (ctx) =>
      ctx.includes("\nChecks:\n") &&
      ![...checks(ctx).values()].includes("pending");
  }
  if (until === "green") {
    return (ctx) => {
      if (!ctx.includes("\nChecks:\n")) return false;
      const statuses = [...checks(ctx).values()];
      return !statuses.includes("pending") && !statuses.includes("failure");
    };
  }
  if (until === "new-failure") {
    const before = checks(initial);
    return (ctx) =>
      [...checks(ctx)].some(
        ([name, status]) =>
          status === "failure" && before.get(name) !== "failure",
      );
  }
  const before = commentIds(initial);
  return (ctx) => [...commentIds(ctx)].some((id) => !before.has(id));
}

function parseArgs(argv: string[]) {
  let url: string | undefined;
  let until: Until | undefined;
  let timeout: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--until") {
      const v = argv[++i];
      if (
        v !== "checks-done" &&
        v !== "green" &&
        v !== "new-failure" &&
        v !== "new-comment"
      )
        throw new Error(
          "--until must be checks-done|green|new-failure|new-comment",
        );
      until = v;
    } else if (a === "--timeout") timeout = Number(argv[++i]);
    else if (a !== undefined && url === undefined) url = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!url || !until)
    throw new Error(
      "usage: wait-pr.ts <pr-url> --until checks-done|green|new-failure|new-comment [--timeout S]",
    );
  return { url, until, timeout };
}

async function main(): Promise<string> {
  const { url, until, timeout } = parseArgs(process.argv.slice(2));
  const manifest = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "manifest.json",
  );
  // The baseline is the first state seen, kept across watcher reconnects.
  let predicate: ((ctx: string) => boolean) | undefined;
  return watchUntil(
    manifest,
    url,
    (s) => {
      if (s.status === "unavailable") throw new Error(s.error);
      if (!hasContext(s) || !s.context) return undefined;
      predicate ??= makePredicate(until, s.context);
      return predicate(s.context) ? s.context : undefined;
    },
    timeout === undefined ? {} : { timeoutMs: timeout * 1000 },
  );
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().then(
    (ctx) => {
      process.stdout.write(`${ctx}\n`);
      process.exit(0);
    },
    (e: Error) => {
      process.stderr.write(`${e.message}\n`);
      process.exit(e instanceof WaitTimeoutError ? 2 : 1);
    },
  );
}
