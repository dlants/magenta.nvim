import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { parseResourceState, parseWatcherManifest } from "@magenta/server";
import { afterEach, describe, expect, it } from "vitest";
import { connectWatcher, type WatcherClient, watchUntil } from "../client.ts";
import type { ResourceState } from "../protocol.ts";
import { regexScan } from "../server.ts";

const FIXTURE = path.join(
  import.meta.dirname,
  "fixtures",
  "counter-watcher.ts",
);
const WAIT = path.join(import.meta.dirname, "..", "wait.ts");

let dirs: string[] = [];
let clients: WatcherClient[] = [];

afterEach(() => {
  for (const c of clients) c.close();
  clients = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function setup(opts: { idleMs?: number } = {}) {
  // /tmp keeps the socket path under the unix socket length limit.
  const dir = mkdtempSync("/tmp/mw-");
  dirs.push(dir);
  const manifest = path.join(dir, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      name: "counter",
      protocolVersion: 1,
      command: [
        process.execPath,
        "--experimental-transform-types",
        FIXTURE,
        "--interval",
        "50",
        "--idle",
        String(opts.idleMs ?? 400),
      ],
      socket: "./w.sock",
    }),
  );
  const file = (name: string, content?: string) => {
    const p = path.join(dir, name);
    if (content !== undefined) writeFileSync(p, content);
    return p;
  };
  const connect = async () => {
    const c = await connectWatcher(manifest);
    clients.push(c);
    return c;
  };
  const polls = (key: string) =>
    existsSync(`${key}.polls`)
      ? readFileSync(`${key}.polls`, "utf8").split("\n").length - 1
      : 0;
  return {
    dir,
    manifest,
    socket: path.join(dir, "w.sock"),
    file,
    connect,
    polls,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function collect(c: WatcherClient): ResourceState[] {
  const states: ResourceState[] = [];
  c.onState((s) => states.push(s));
  return states;
}

async function until(cond: () => boolean, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met");
    await sleep(20);
  }
}

function runNode(
  args: string[],
  cwd?: string,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(
      process.execPath,
      ["--experimental-transform-types", ...args],
      { cwd },
    );
    let stdout = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.on("exit", (code) => resolve({ code, stdout }));
  });
}

describe("watcher sdk", () => {
  it("spawns on connect and answers hello", async () => {
    const t = setup();
    const c = await t.connect();
    expect(await c.hello()).toEqual({ name: "counter", protocolVersion: 1 });
  });

  it("scan returns deduped keys without starting a poller", async () => {
    const t = setup();
    const key = t.file("a", "1");
    const c = await t.connect();
    const keys = await c.scan([
      `see counter:${key} and\ncounter:${key}`,
      `counter:${key} plus counter:other`,
    ]);
    expect(keys).toEqual([key, "other"]);
    await sleep(200);
    expect(t.polls(key)).toBe(0);
    expect(await c.list()).toEqual([]);
  });
  it("rejects a scan whose texts are not a string array", async () => {
    const t = setup();
    const c = await t.connect();
    await expect(c.request("scan", { texts: [1] })).rejects.toThrow(
      /texts must be a string array/,
    );
    await expect(c.request("scan", {})).rejects.toThrow();
  });
  it("regexScan: whole-match default, existing g flag, empty groups skipped", () => {
    const scan = regexScan([
      { pattern: /pr-\d+/g },
      { pattern: /repo:(\w*)/, keyGroup: 1 },
    ]);
    expect(scan(["pr-1 pr-2 pr-1", "repo:x repo: repo:x"])).toEqual([
      "pr-1",
      "pr-2",
      "x",
    ]);
    expect(scan(["pr-3"])).toEqual(["pr-3"]);
  });
  it("refcounts pollers per key and stops on last unsubscribe", async () => {
    const t = setup();
    const key = t.file("a", "1");
    const c1 = await t.connect();
    const c2 = await t.connect();
    const s1 = await c1.subscribe(key);
    expect(s1).toMatchObject({
      status: "active",
      context: "count: 1",
      summary: "count 1",
    });
    await sleep(200);
    const s2 = await c2.subscribe(key);
    expect(s2.context).toBe("count: 1");
    const before = t.polls(key);
    await sleep(500);
    const rate = t.polls(key) - before;
    // ~10 polls at 50ms; two pollers would give ~20.
    expect(rate).toBeLessThan(15);
    await c1.unsubscribe(key);
    await sleep(150);
    expect(t.polls(key)).toBeGreaterThan(before);
    await c2.unsubscribe(key);
    await sleep(100);
    const stopped = t.polls(key);
    await sleep(300);
    expect(t.polls(key)).toBe(stopped);
  });

  it("pushes full state only when the rendering changes", async () => {
    const t = setup();
    const key = t.file("a", "1");
    const c1 = await t.connect();
    const c2 = await t.connect();
    const st1 = collect(c1);
    const st2 = collect(c2);
    await c1.subscribe(key);
    await c2.subscribe(key, { prefix: "n" });
    t.file("a", "1\nhidden note");
    await sleep(300);
    expect(st1).toEqual([]);
    expect(st2).toEqual([]);
    t.file("a", "2");
    await until(() => st1.length === 1 && st2.length === 1);
    expect(st1[0]).toMatchObject({
      key,
      status: "active",
      context: "count: 2",
      summary: "count 2",
    });
    expect(st2[0]?.context).toBe("n: 2");
  });

  it("releases subscriptions when a connection closes", async () => {
    const t = setup();
    const key = t.file("a", "1");
    const c1 = await t.connect();
    const c2 = await t.connect();
    await c1.subscribe(key);
    expect((await c2.list()).map((s) => s.key)).toEqual([key]);
    c1.close();
    await sleep(100);
    expect(await c2.list()).toEqual([]);
  });

  it("exits when idle and unlinks the socket", async () => {
    const t = setup({ idleMs: 200 });
    const c = await t.connect();
    c.close();
    await until(() => !existsSync(t.socket));
    // Reconnecting respawns.
    const c2 = await t.connect();
    expect((await c2.hello()).name).toBe("counter");
  });

  it("second instance exits on a live socket and takes over a stale one", async () => {
    const t = setup({ idleMs: 2000 });
    const c = await t.connect();
    const second = await runNode([FIXTURE, "--idle", "2000"], t.dir);
    expect(second.code).toBe(0);
    expect((await c.hello()).name).toBe("counter");
    c.close();

    const t2 = setup({ idleMs: 300 });
    // A socket path nobody listens on (left behind by a crashed watcher).
    writeFileSync(t2.socket, "");
    const c2 = await t2.connect();
    expect((await c2.hello()).name).toBe("counter");
  });

  it("backs off on errors as failing; unavailable and finished are terminal", async () => {
    const t = setup();
    const bad = t.file("bad", "ERR");
    const c = await t.connect();
    const s = await c.subscribe(bad);
    expect(s).toMatchObject({ status: "failing", error: "bad counter" });
    await sleep(600);
    // backoff 100, 200, 400, 400 ms → far fewer than 12 fixed-interval polls
    expect(t.polls(bad)).toBeLessThan(7);

    const missing = path.join(t.dir, "missing");
    expect(await c.subscribe(missing)).toMatchObject({ status: "unavailable" });
    await sleep(200);
    expect(t.polls(missing)).toBe(1);

    const done = t.file("done", "DONE");
    expect(await c.subscribe(done)).toMatchObject({ status: "finished" });
  });

  it("watchUntil survives the watcher being killed and respawns it", async () => {
    const t = setup({ idleMs: 2000 });
    const key = t.file("a", "1");
    const pidFile = path.join(t.dir, "pid");
    const seen: string[] = [];
    const waiting = watchUntil(t.manifest, key, (s) => {
      seen.push(s.context);
      return s.context === "count: 3" ? s.context : undefined;
    });
    await until(() => seen.includes("count: 1") && existsSync(pidFile));
    const firstPid = Number(readFileSync(pidFile, "utf8"));
    process.kill(firstPid, "SIGKILL");
    t.file("a", "2");
    await until(() => Number(readFileSync(pidFile, "utf8")) !== firstPid, 5000);
    await until(() => seen.includes("count: 2"), 5000);
    t.file("a", "3");
    expect(await waiting).toBe("count: 3");
  });

  it("wait.ts returns on a matching pushed state and fails on timeout", async () => {
    const t = setup();
    const key = t.file("a", "1");
    const immediate = await runNode([
      WAIT,
      key,
      "--manifest",
      t.manifest,
      "--match",
      "count: 1",
    ]);
    expect(immediate).toEqual({ code: 0, stdout: "count: 1\n" });

    const pending = runNode([
      WAIT,
      key,
      "--manifest",
      t.manifest,
      "--match",
      "count: 3",
      "--timeout",
      "10",
    ]);
    await sleep(300);
    t.file("a", "3");
    expect(await pending).toEqual({ code: 0, stdout: "count: 3\n" });

    const timeout = await runNode([
      WAIT,
      key,
      "--manifest",
      t.manifest,
      "--match",
      "count: 9",
      "--timeout",
      "0.3",
    ]);
    expect(timeout.code).toBe(2);
  });

  it("magenta's parsers accept what the sdk emits", async () => {
    const t = setup();
    const manifest = parseWatcherManifest(
      JSON.parse(readFileSync(t.manifest, "utf8")),
    );
    expect(manifest.status).toBe("ok");
    const c = await t.connect();
    const states = [
      await c.subscribe(t.file("a", "1")),
      await c.subscribe(t.file("bad", "ERR")),
      await c.subscribe(path.join(t.dir, "missing")),
      await c.subscribe(t.file("done", "DONE")),
    ];
    for (const s of states) expect(parseResourceState(s)).toEqual(s);
  });
});
