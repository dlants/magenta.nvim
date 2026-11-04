import type { OutputLine, Shell, ShellResult } from "../capabilities/shell.ts";
import type {
  ClientEffectHandler,
  ClientInfo,
  ClientNotification,
  ClientRequest,
  ClientRequestHandlers,
  ClientResponse,
} from "../protocol/client.ts";
import { createClientEffectHandler } from "../protocol/client.ts";
import { Defer } from "../utils/async.ts";
import type { ResourceState, WatcherName } from "../watchers/protocol.ts";
import type {
  LoadedWatcherManifest,
  WatcherConnection,
  WatcherTransport,
} from "../watchers/watcher-registry.ts";

export type FakeShellResponse = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};
/** Command -> canned response. Unscripted commands stay pending until the test
 * settles them through `FakeShell.pending`. */
export type FakeShellScript = Record<string, FakeShellResponse>;

export function shellResult(response: FakeShellResponse): ShellResult {
  const output: OutputLine[] = [
    ...(response.stdout ?? "")
      .split("\n")
      .filter((text) => text.length)
      .map((text) => ({ stream: "stdout" as const, text })),
    ...(response.stderr ?? "")
      .split("\n")
      .filter((text) => text.length)
      .map((text) => ({ stream: "stderr" as const, text })),
  ];
  return {
    exitCode: response.exitCode ?? 0,
    signal: undefined,
    output,
    logFilePath: undefined,
    durationMs: 0,
  };
}

export class FakeShell implements Shell {
  readonly calls: string[] = [];
  /** Unscripted executions, in order, for the test to resolve. */
  readonly pending: { command: string; result: Defer<ShellResult> }[] = [];
  terminated = 0;

  constructor(private script: FakeShellScript = {}) {}

  execute(
    command: string,
    opts: { onOutput?: (line: OutputLine) => void; onStart?: () => void },
  ): Promise<ShellResult> {
    this.calls.push(command);
    opts.onStart?.();
    const scripted = this.script[command];
    if (scripted) {
      const result = shellResult(scripted);
      for (const line of result.output) opts.onOutput?.(line);
      return Promise.resolve(result);
    }
    const result = new Defer<ShellResult>();
    this.pending.push({ command, result });
    return result.promise;
  }

  terminate(): void {
    this.terminated++;
    for (const { result } of this.pending.splice(0)) {
      result.resolve({ ...shellResult({ exitCode: 143 }), signal: "SIGTERM" });
    }
  }
}

/** A client that records every request/notification and answers requests
 * with `respond` (default: `undefined`). */
/** Records requests/notifications; `info` is derived from which of the
 * optional handlers (`oauth`, `fileWritten`) are supplied. */
export class FakeClient implements ClientEffectHandler {
  readonly requests: ClientRequest[] = [];
  readonly notifications: ClientNotification[] = [];
  readonly info: ClientInfo;
  private inner: ClientEffectHandler;
  constructor(
    handlers: Partial<ClientRequestHandlers> = {},
    neovimVersion = "test",
  ) {
    const unhandled = (req: ClientRequest) =>
      Promise.reject(new Error(`FakeClient: unhandled ${req.type}`));
    this.inner = createClientEffectHandler({
      neovimVersion,
      handlers: {
        lsp: unhandled,
        lua: unhandled,
        expandClientCommand: unhandled,
        ...handlers,
      },
      notify: (n) => this.notifications.push(n),
    });
    this.info = this.inner.info;
  }
  request<R extends ClientRequest>(req: R): Promise<ClientResponse<R>> {
    this.requests.push(req);
    return this.inner.request(req);
  }
  notify(n: ClientNotification): void {
    this.inner.notify(n);
  }
}

type FakeWatcherConn = {
  watcher: WatcherName;
  keys: Set<string>;
  stateCbs: Array<(s: ResourceState) => void>;
  closeCbs: Array<() => void>;
  closed: boolean;
};
/** In-memory watchers: tests set resource states with `push`; subscribers on
 * open connections receive them like socket notifications. */
export class FakeWatcherTransport implements WatcherTransport {
  readonly states = new Map<string, ResourceState>();
  readonly connections: FakeWatcherConn[] = [];
  readonly unreachable = new Set<string>();
  /** Keys whose subscribe rejects, like a watcher refusing the key. */
  readonly rejectSubscribe = new Set<string>();
  /** When set, subscribes wait for this promise before answering. */
  holdSubscribes: Promise<void> | undefined;
  /** Per-watcher scan logic; watchers without one find no keys. */
  readonly scanners = new Map<
    WatcherName,
    (texts: string[]) => string[] | Promise<string[]>
  >();
  readonly scanCalls: Array<{ watcher: WatcherName; texts: string[] }> = [];
  private id = (watcher: string, key: string) => `${watcher}\0${key}`;

  connect(manifest: LoadedWatcherManifest): Promise<WatcherConnection> {
    if (this.unreachable.has(manifest.name)) {
      return Promise.reject(new Error("connection refused"));
    }
    const conn: FakeWatcherConn = {
      watcher: manifest.name,
      keys: new Set(),
      stateCbs: [],
      closeCbs: [],
      closed: false,
    };
    this.connections.push(conn);
    const close = () => {
      if (conn.closed) return;
      conn.closed = true;
      for (const cb of conn.closeCbs) cb();
    };
    return Promise.resolve({
      subscribe: async (key) => {
        if (this.holdSubscribes) await this.holdSubscribes;
        if (this.rejectSubscribe.has(key)) throw new Error(`rejected ${key}`);
        conn.keys.add(key);
        return (
          this.states.get(this.id(conn.watcher, key)) ?? {
            key,
            status: "loading",
            context: "",
            summary: "loading",
          }
        );
      },
      scan: async (texts) => {
        this.scanCalls.push({ watcher: conn.watcher, texts });
        return (await this.scanners.get(conn.watcher)?.(texts)) ?? [];
      },
      unsubscribe: (key) => conn.keys.delete(key),
      onState: (cb) => conn.stateCbs.push(cb),
      onClose: (cb) => conn.closeCbs.push(cb),
      close,
    });
  }

  push(watcher: string, state: ResourceState): void {
    this.states.set(this.id(watcher, state.key), state);
    for (const c of this.connections) {
      if (!c.closed && c.watcher === watcher && c.keys.has(state.key)) {
        for (const cb of c.stateCbs) cb(state);
      }
    }
  }

  /** Simulates the watcher going away: closes every open connection. */
  dropConnections(watcher: string): void {
    for (const c of this.connections) {
      if (c.closed || c.watcher !== watcher) continue;
      c.closed = true;
      for (const cb of c.closeCbs) cb();
    }
  }

  subscriberCount(watcher: string, key: string): number {
    return this.connections.filter(
      (c) => !c.closed && c.watcher === watcher && c.keys.has(key),
    ).length;
  }
}
