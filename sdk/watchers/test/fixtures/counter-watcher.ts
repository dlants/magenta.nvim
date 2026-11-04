/**
 * Toy watcher for tests. Key = path of a file whose first line is a counter.
 * Extra lines are a "note" hidden from both render and summarize. Missing
 * file → unavailable; "ERR" → poll error; "DONE" → finished. Each poll appends
 * a line to `<key>.polls` so tests can count pollers.
 * Scan: `counter:<path>` mentions yield `<path>`.
 * Writes its pid to `./pid` so tests can kill it.
 * argv: --interval <ms> --idle <ms>
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { regexScan, serveWatcher } from "../../server.ts";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
}

writeFileSync("./pid", String(process.pid));

type Snapshot = { count: string; note: string };

serveWatcher<Snapshot, { prefix?: string }>({
  manifest: "./manifest.json",
  intervalMs: arg("--interval", 50),
  maxBackoffMs: 400,
  idleExitMs: arg("--idle", 500),
  async poll(key) {
    try {
      appendFileSync(`${key}.polls`, "poll\n");
    } catch {}
    let text: string;
    try {
      text = readFileSync(key, "utf8");
    } catch {
      return { kind: "unavailable", error: "no such file" };
    }
    const [count = "", ...rest] = text.split("\n");
    if (count === "ERR") return { kind: "error", error: "bad counter" };
    return { kind: "ok", snapshot: { count, note: rest.join("\n") } };
  },
  scan: regexScan([{ pattern: /counter:(\S+)/, keyGroup: 1 }]),
  isFinished: (s) => s.count === "DONE",
  summarize: (s) => ({ summary: `count ${s.count}` }),
  render: (s, filter) => `${filter?.prefix ?? "count"}: ${s.count}`,
});
