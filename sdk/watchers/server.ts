import { mkdirSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  lineSplitter,
  PROTOCOL_VERSION,
  parseJsonRpcLine,
  type ResourceState,
  readManifest,
} from "./protocol.ts";

export type PollResult<S> =
  | { kind: "ok"; snapshot: S }
  | { kind: "unavailable"; error: string }
  | { kind: "error"; error: string };

export type WatcherSpec<S, F = unknown> = {
  /** Path to manifest.json; supplies name and socket default. */
  manifest: string;
  poll(
    key: string,
    ctx: { previous: S | undefined; signal: AbortSignal },
  ): Promise<PollResult<S>>;
  /** Canonical keys mentioned in `texts` (exactly what `subscribe` will get).
   * Pure: must not subscribe or poll. */
  scan(texts: string[]): string[] | Promise<string[]>;
  isFinished?(s: S): boolean;
  summarize(s: S): { summary: string; details?: string };
  /** The agent-facing context blob. */
  render(s: S, filter: F | undefined): string;
  intervalMs?: number;
  maxBackoffMs?: number;
  /** Exit after this long with zero connections. Env MAGENTA_WATCHER_IDLE_MS overrides. */
  idleExitMs?: number;
  log?(msg: string): void;
};

/** A `WatcherSpec.scan` that matches each pattern globally and dedupes.
 * The key is `keyGroup` (default: the whole match). */
export function regexScan(
  patterns: Array<{ pattern: RegExp; keyGroup?: number }>,
): (texts: string[]) => string[] {
  return (texts) => {
    const keys = new Set<string>();
    for (const text of texts) {
      for (const { pattern, keyGroup } of patterns) {
        const flags = pattern.flags.includes("g")
          ? pattern.flags
          : `${pattern.flags}g`;
        for (const m of text.matchAll(new RegExp(pattern.source, flags))) {
          const key = m[keyGroup ?? 0];
          if (key) keys.add(key);
        }
      }
    }
    return [...keys];
  };
}

/** `pending` until the subscribe response (which carries the state) is sent. */
type Sub<F> = {
  filter: F | undefined;
  lastSent: string | undefined;
  pending: boolean;
};

type PollerPhase =
  | { status: "loading" | "active" | "finished" }
  | { status: "failing" | "unavailable"; error: string };

type Request = { method: string; params: Record<string, unknown> };

type Poller<S, F> = {
  key: string;
  subs: Map<net.Socket, Sub<F>>;
  phase: PollerPhase;
  snapshot: S | undefined;
  failures: number;
  timer: NodeJS.Timeout | undefined;
  abort: AbortController;
  firstPoll: Promise<void>;
};

/**
 * Runs a watcher: binds the socket (the bind is the single-instance lock),
 * keeps one poller per key while any connection subscribes to it, and pushes
 * full state to a subscription only when its rendering changes.
 */
export function serveWatcher<S, F = unknown>(spec: WatcherSpec<S, F>): void {
  const manifest = readManifest(spec.manifest);
  const socketPath = process.env.MAGENTA_WATCHER_SOCKET ?? manifest.socketPath;
  const intervalMs = spec.intervalMs ?? 30_000;
  const maxBackoffMs = spec.maxBackoffMs ?? 10 * 60_000;
  const idleExitMs = process.env.MAGENTA_WATCHER_IDLE_MS
    ? Number(process.env.MAGENTA_WATCHER_IDLE_MS)
    : (spec.idleExitMs ?? 60_000);
  const log =
    spec.log ?? ((m: string) => console.error(`[${manifest.name}] ${m}`));

  const pollers = new Map<string, Poller<S, F>>();
  const connections = new Set<net.Socket>();
  let idleTimer: NodeJS.Timeout | undefined;

  function stateFor(p: Poller<S, F>, filter: F | undefined): ResourceState {
    const state: ResourceState = {
      key: p.key,
      ...p.phase,
      context: "",
      summary: p.phase.status,
    };
    if (p.snapshot !== undefined) {
      state.context = spec.render(p.snapshot, filter);
      const { summary, details } = spec.summarize(p.snapshot);
      state.summary = summary;
      if (details !== undefined) state.details = details;
    }
    return state;
  }

  function send(socket: net.Socket, msg: unknown) {
    if (!socket.destroyed) socket.write(`${JSON.stringify(msg)}\n`);
  }

  function push(p: Poller<S, F>) {
    for (const [socket, sub] of p.subs) {
      if (sub.pending) continue;
      const state = stateFor(p, sub.filter);
      const serialized = JSON.stringify(state);
      if (serialized === sub.lastSent) continue;
      sub.lastSent = serialized;
      send(socket, { jsonrpc: "2.0", method: "state", params: state });
    }
  }

  async function runPoll(p: Poller<S, F>): Promise<void> {
    let result: PollResult<S>;
    try {
      result = await spec.poll(p.key, {
        previous: p.snapshot,
        signal: p.abort.signal,
      });
    } catch (e) {
      result = { kind: "error", error: (e as Error).message };
    }
    if (p.abort.signal.aborted) return;
    let delay: number | undefined = intervalMs;
    if (result.kind === "ok") {
      p.snapshot = result.snapshot;
      p.failures = 0;
      if (spec.isFinished?.(result.snapshot)) {
        p.phase = { status: "finished" };
        delay = undefined;
      } else {
        p.phase = { status: "active" };
      }
    } else if (result.kind === "unavailable") {
      p.phase = { status: "unavailable", error: result.error };
      delay = undefined;
    } else {
      p.phase = { status: "failing", error: result.error };
      p.failures++;
      delay = Math.min(intervalMs * 2 ** p.failures, maxBackoffMs);
    }
    push(p);
    if (delay !== undefined) {
      p.timer = setTimeout(() => void runPoll(p), delay);
    }
  }

  function getPoller(key: string): Poller<S, F> {
    let p = pollers.get(key);
    if (!p) {
      const created: Poller<S, F> = {
        key,
        subs: new Map(),
        phase: { status: "loading" },
        snapshot: undefined,
        failures: 0,
        timer: undefined,
        abort: new AbortController(),
        firstPoll: Promise.resolve(),
      };
      created.firstPoll = runPoll(created);
      pollers.set(key, created);
      p = created;
    }
    return p;
  }

  function release(p: Poller<S, F>, socket: net.Socket) {
    p.subs.delete(socket);
    if (p.subs.size > 0) return;
    p.abort.abort();
    clearTimeout(p.timer);
    pollers.delete(p.key);
  }

  async function handle(socket: net.Socket, req: Request): Promise<unknown> {
    const params = req.params;
    // Filters are watcher-defined JSON; the watcher's render() owns validating them.
    const filter = params.filter as F | undefined;
    const key = () => {
      if (typeof params.key !== "string")
        throw new Error("key must be a string");
      return params.key;
    };
    switch (req.method) {
      case "hello":
        return { name: manifest.name, protocolVersion: PROTOCOL_VERSION };
      case "scan": {
        const texts = params.texts;
        if (
          !Array.isArray(texts) ||
          !texts.every((t): t is string => typeof t === "string")
        ) {
          throw new Error("texts must be a string array");
        }
        return { keys: [...new Set(await spec.scan(texts))] };
      }
      case "subscribe": {
        const p = getPoller(key());
        const sub: Sub<F> = {
          filter: filter,
          lastSent: undefined,
          pending: true,
        };
        p.subs.set(socket, sub);
        await p.firstPoll;
        const state = stateFor(p, sub.filter);
        sub.lastSent = JSON.stringify(state);
        sub.pending = false;
        return state;
      }
      case "unsubscribe": {
        const p = pollers.get(key());
        if (p) release(p, socket);
        return undefined;
      }
      case "get": {
        const existing = pollers.get(key());
        if (existing) {
          await existing.firstPoll;
          return stateFor(existing, filter);
        }
        const p = getPoller(key());
        await p.firstPoll;
        const state = stateFor(p, filter);
        if (p.subs.size === 0) {
          p.abort.abort();
          clearTimeout(p.timer);
          pollers.delete(p.key);
        }
        return state;
      }
      case "list":
        return [...pollers.values()].map((p) => stateFor(p, undefined));
      default:
        throw Object.assign(new Error(`unknown method ${req.method}`), {
          code: -32601,
        });
    }
  }

  function scheduleIdleExit() {
    clearTimeout(idleTimer);
    if (connections.size > 0) return;
    idleTimer = setTimeout(() => {
      log("idle, exiting");
      server.close();
      try {
        unlinkSync(socketPath);
      } catch {}
      process.exit(0);
    }, idleExitMs);
  }

  const server = net.createServer((socket) => {
    connections.add(socket);
    scheduleIdleExit();
    socket.on(
      "data",
      lineSplitter((line) => {
        const msg = parseJsonRpcLine(line);
        if (!msg) {
          send(socket, {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "parse error" },
          });
          return;
        }
        if (msg.kind !== "request") return;
        const req = { id: msg.id, method: msg.method };
        const params =
          typeof msg.params === "object" &&
          msg.params !== null &&
          !Array.isArray(msg.params)
            ? (msg.params as Record<string, unknown>)
            : {};
        handle(socket, { method: msg.method, params }).then(
          // JSON-RPC requires a result member; undefined becomes null on the wire.
          (result) =>
            send(socket, {
              jsonrpc: "2.0",
              id: req.id,
              result: result ?? null,
            }),
          (e: Error & { code?: number }) =>
            send(socket, {
              jsonrpc: "2.0",
              id: req.id,
              error: {
                code: typeof e.code === "number" ? e.code : -32000,
                message: e.message,
              },
            }),
        );
      }),
    );
    const onGone = () => {
      if (!connections.delete(socket)) return;
      for (const p of [...pollers.values()]) {
        if (p.subs.has(socket)) release(p, socket);
      }
      scheduleIdleExit();
    };
    socket.on("close", onGone);
    socket.on("error", onGone);
  });

  mkdirSync(path.dirname(socketPath), { recursive: true });
  server.on("listening", () => {
    log(`listening on ${socketPath}`);
    scheduleIdleExit();
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") throw err;
    const probe = net.connect(socketPath);
    probe.on("connect", () => {
      log("another instance owns the socket, exiting");
      probe.destroy();
      process.exit(0);
    });
    probe.on("error", () => {
      log("removing stale socket");
      try {
        unlinkSync(socketPath);
      } catch {}
      server.listen(socketPath);
    });
  });
  server.listen(socketPath);
}
