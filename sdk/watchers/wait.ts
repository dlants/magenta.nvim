/**
 * CLI: wait until a watched resource matches.
 *   node --experimental-transform-types wait.ts <key> --manifest <path>
 *     [--field context|summary|details|status] [--match <regex>] [--timeout <seconds>]
 * Without --match, waits for status finished. Prints the matching state's
 * field and exits 0; exits 2 on timeout, 1 on other errors.
 */
import { WaitTimeoutError, waitFor } from "./client.ts";
import type { ResourceState } from "./protocol.ts";

type Field = "context" | "summary" | "details" | "status";

function parseArgs(argv: string[]) {
  let key: string | undefined;
  let manifest: string | undefined;
  let field: Field = "context";
  let match: string | undefined;
  let timeout: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--manifest") manifest = next();
    else if (a === "--field") field = next() as Field;
    else if (a === "--match") match = next();
    else if (a === "--timeout") timeout = Number(next());
    else if (a !== undefined && key === undefined) key = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!key || !manifest)
    throw new Error(
      "usage: wait.ts <key> --manifest <path> [--field f] [--match re] [--timeout s]",
    );
  return { key, manifest, field, match, timeout };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const regex =
    args.match === undefined ? undefined : new RegExp(args.match, "m");
  const fieldOf = (s: ResourceState) => s[args.field] ?? "";
  const state = await waitFor(
    args.manifest,
    args.key,
    (s) => (regex ? regex.test(fieldOf(s)) : s.status === "finished"),
    args.timeout === undefined ? {} : { timeoutMs: args.timeout * 1000 },
  );
  process.stdout.write(`${fieldOf(state)}\n`);
}

main().then(
  () => process.exit(0),
  (e: Error) => {
    process.stderr.write(`${e.message}\n`);
    process.exit(e instanceof WaitTimeoutError ? 2 : 1);
  },
);
