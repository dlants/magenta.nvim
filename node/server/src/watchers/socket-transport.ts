import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { parseJsonRpcLine, parseResourceState } from "./protocol.ts";
import type {
  LoadedWatcherManifest,
  WatcherConnection,
  WatcherTransport,
} from "./watcher-registry.ts";

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

/** Detached so the watcher outlives this magenta process. */
function spawnWatcher(manifest: LoadedWatcherManifest): void {
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
  child.on("error", () => {});
  child.unref();
}

class SocketConnection implements WatcherConnection {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private stateListeners: Array<Parameters<WatcherConnection["onState"]>[0]> =
    [];
  private closeListeners: Array<() => void> = [];

  constructor(private readonly socket: net.Socket) {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) this.handleLine(line);
        nl = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => {
      for (const p of this.pending.values())
        p.reject(new Error("watcher connection closed"));
      this.pending.clear();
      for (const cb of this.closeListeners) cb();
      this.closeListeners = [];
    });
    socket.on("error", () => {});
  }

  private handleLine(line: string): void {
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
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  async subscribe(key: string, filter?: unknown) {
    const raw = await this.request("subscribe", {
      key,
      ...(filter !== undefined ? { filter } : {}),
    });
    const state = parseResourceState(raw);
    if (!state) throw new Error("watcher sent an invalid ResourceState");
    return state;
  }
  unsubscribe(key: string): void {
    this.request("unsubscribe", { key }).catch(() => {});
  }
  onState(cb: Parameters<WatcherConnection["onState"]>[0]): void {
    this.stateListeners.push(cb);
  }
  onClose(cb: () => void): void {
    this.closeListeners.push(cb);
  }
  close(): void {
    this.socket.end();
  }
}

export class SocketWatcherTransport implements WatcherTransport {
  constructor(private readonly opts: { timeoutMs?: number } = {}) {}
  async connect(manifest: LoadedWatcherManifest): Promise<WatcherConnection> {
    const deadline = Date.now() + (this.opts.timeoutMs ?? 15_000);
    let spawned = false;
    let delay = 50;
    for (;;) {
      const socket = await tryConnect(manifest.socketPath);
      if (socket) return new SocketConnection(socket);
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
}
