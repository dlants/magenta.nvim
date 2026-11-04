import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  type HelloResult,
  type LoadedManifest,
  lineSplitter,
  parseJsonRpcLine,
  parseResourceState,
  type ResourceState,
  readManifest,
} from "./protocol.ts";

function expectState(raw: unknown): ResourceState {
  const state = parseResourceState(raw);
  if (!state) throw new Error("watcher sent an invalid ResourceState");
  return state;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class WatcherClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stateListeners = new Set<(s: ResourceState) => void>();
  private closeListeners = new Set<() => void>();

  constructor(private socket: net.Socket) {
    socket.on(
      "data",
      lineSplitter((line) => {
        const msg = parseJsonRpcLine(line);
        if (!msg) return;
        if (msg.kind === "notification" || msg.kind === "request") {
          if (msg.method !== "state") return;
          const state = parseResourceState(msg.params);
          if (state) for (const cb of this.stateListeners) cb(state);
          return;
        }
        if (typeof msg.id !== "number") return;
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.kind === "error") p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }),
    );
    socket.on("close", () => {
      for (const p of this.pending.values())
        p.reject(new Error("watcher connection closed"));
      this.pending.clear();
      for (const cb of this.closeListeners) cb();
    });
    socket.on("error", () => {});
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  async hello(): Promise<HelloResult> {
    const r = await this.request("hello");
    if (
      typeof r !== "object" ||
      r === null ||
      !("name" in r) ||
      typeof r.name !== "string" ||
      !("protocolVersion" in r) ||
      r.protocolVersion !== 1
    ) {
      throw new Error("invalid hello result");
    }
    return { name: r.name, protocolVersion: 1 };
  }
  async scan(texts: string[]): Promise<string[]> {
    const r = await this.request("scan", { texts });
    if (
      typeof r !== "object" ||
      r === null ||
      !("keys" in r) ||
      !Array.isArray(r.keys) ||
      !r.keys.every((k: unknown) => typeof k === "string")
    ) {
      throw new Error("invalid scan result");
    }
    return r.keys;
  }
  async subscribe(key: string, filter?: unknown): Promise<ResourceState> {
    return expectState(
      await this.request(
        "subscribe",
        filter === undefined ? { key } : { key, filter },
      ),
    );
  }
  async unsubscribe(key: string): Promise<void> {
    await this.request("unsubscribe", { key });
  }
  async get(key: string, filter?: unknown): Promise<ResourceState> {
    return expectState(
      await this.request(
        "get",
        filter === undefined ? { key } : { key, filter },
      ),
    );
  }
  async list(): Promise<ResourceState[]> {
    const r = await this.request("list");
    if (!Array.isArray(r)) throw new Error("invalid list result");
    return r.map(expectState);
  }
  onState(cb: (s: ResourceState) => void): () => void {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }
  onClose(cb: () => void): void {
    this.closeListeners.add(cb);
  }
  close(): void {
    this.socket.end();
    this.socket.destroy();
  }
}

function tryConnect(socketPath: string): Promise<net.Socket | undefined> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      resolve(socket);
    });
    socket.once("error", () => resolve(undefined));
  });
}

/** Starts the watcher detached so it outlives whichever client spawned it. */
export function spawnWatcher(manifest: LoadedManifest): void {
  mkdirSync(path.dirname(manifest.socketPath), { recursive: true });
  const logFd = openSync(`${manifest.socketPath}.log`, "a");
  const [cmd, ...args] = manifest.command;
  if (!cmd) throw new Error(`watcher ${manifest.name}: empty command`);
  const child = spawn(cmd, args, {
    cwd: manifest.dir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, MAGENTA_WATCHER_SOCKET: manifest.socketPath },
  });
  child.unref();
}

/** Connect-or-spawn: connects to the watcher's socket, starting it if needed. */
export async function connectWatcher(
  manifestPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<WatcherClient> {
  const manifest = readManifest(manifestPath);
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  let spawned = false;
  let delay = 50;
  for (;;) {
    const socket = await tryConnect(manifest.socketPath);
    if (socket) return new WatcherClient(socket);
    if (!spawned) {
      spawnWatcher(manifest);
      spawned = true;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `watcher ${manifest.name}: could not connect to ${manifest.socketPath} (see ${manifest.socketPath}.log)`,
      );
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 1000);
  }
}

export class WaitTimeoutError extends Error {}

/**
 * Subscribes to `key` and resolves with the first non-undefined `check`
 * result (the initial state included); a throwing `check` rejects. If the
 * watcher drops (killed, crashed), reconnects after a jittered ~1s delay,
 * respawning it if needed, and resubscribes; `check` then sees the current
 * state again. Rejects on timeout or if a reconnect fails.
 */
export function watchUntil<T>(
  manifestPath: string,
  key: string,
  check: (s: ResourceState) => T | undefined,
  opts: { timeoutMs?: number; filter?: unknown } = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let client: WatcherClient | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client?.close();
      settle();
    };
    const onState = (s: ResourceState) => {
      if (done || s.key !== key) return;
      try {
        const result = check(s);
        if (result !== undefined) finish(() => resolve(result));
      } catch (e) {
        finish(() => reject(e));
      }
    };
    const fail = (e: unknown) => finish(() => reject(e));
    const attach = async () => {
      const c = await connectWatcher(manifestPath);
      if (done) return c.close();
      client = c;
      c.onState(onState);
      c.onClose(() => {
        if (done || client !== c) return;
        client = undefined;
        const delay = 1_000 * (0.5 + Math.random());
        setTimeout(() => attach().catch(fail), delay);
      });
      try {
        onState(await c.subscribe(key, opts.filter));
      } catch (e) {
        // A subscribe cut off by a drop is retried by the close handler.
        if (client === c) throw e;
      }
    };
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(
        () => fail(new WaitTimeoutError(`timed out waiting for ${key}`)),
        opts.timeoutMs,
      );
      timer.unref();
    }
    attach().catch(fail);
  });
}

/**
 * Resolves with the first state satisfying `predicate`. Rejects on timeout or
 * if the resource becomes `unavailable` without matching. Survives watcher
 * restarts (see `watchUntil`).
 */
export function waitFor(
  manifestPath: string,
  key: string,
  predicate: (s: ResourceState) => boolean,
  opts: { timeoutMs?: number; filter?: unknown } = {},
): Promise<ResourceState> {
  return watchUntil(
    manifestPath,
    key,
    (s) => {
      if (predicate(s)) return s;
      if (s.status === "unavailable")
        throw new Error(`${key} is unavailable: ${s.error}`);
      return undefined;
    },
    opts,
  );
}
