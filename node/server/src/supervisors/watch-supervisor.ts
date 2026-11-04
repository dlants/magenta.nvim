import { diffLines } from "diff";
import type { NativeMessageIdx } from "../providers/provider-types.ts";
import type {
  RequestContext,
  SupervisorAction,
  ToolLoopSupervisor,
} from "../thread-supervisor.ts";
import { injectText } from "../thread-supervisor.ts";
import type { ResourceState } from "../watchers/protocol.ts";
import type {
  ResourceRef,
  WatcherConnection,
  WatcherRegistry,
} from "../watchers/watcher-registry.ts";

export const WATCH_DORMANT_AFTER_MS = 5 * 60_000;
const DORMANCY_CHECK_MS = 30_000;
const RECONNECT_DELAY_MS = 1_000;

export type WatchSeed = ResourceRef & { seen?: string };
export type WatchUpdate = ResourceRef & { kind: "full" | "diff"; text: string };
export type WatchContextUpdate = { resources: WatchUpdate[] };
export type WatchedResourceView = ResourceRef & {
  state: ResourceState | undefined;
  /** Unsubscribed while the thread is unattended; `state` is the last seen. */
  paused: boolean;
  pendingUpdate: boolean;
};

type ViewEntry = { nativeMessageIdx: NativeMessageIdx; context: string };
type Tracked = ResourceRef & {
  latest: ResourceState | undefined;
  subscribed: boolean;
};
type ConnectionSlot =
  | { type: "connecting"; promise: Promise<WatcherConnection | undefined> }
  | { type: "open"; connection: WatcherConnection };

const refId = (r: ResourceRef) => `${r.watcher}\0${r.key}`;

/** Changed lines only: the agent already has the previous blob in context. */
export function diffBlobs(seen: string, latest: string): string {
  const lines: string[] = [];
  for (const part of diffLines(seen, latest)) {
    if (!part.added && !part.removed) continue;
    const prefix = part.added ? "+ " : "- ";
    for (const line of part.value.replace(/\n$/, "").split("\n")) {
      lines.push(`${prefix}${line}`);
    }
  }
  return lines.join("\n");
}

export function watchUpdateToText(update: WatchContextUpdate): string {
  return [
    "# Watched resource update",
    ...update.resources.map((r) =>
      r.kind === "full"
        ? `## ${r.watcher}: ${r.key}\n\n${r.text}`
        : `## ${r.watcher}: ${r.key} (changed lines)\n\n${r.text}`,
    ),
  ].join("\n\n");
}

export type WatchSupervisorCallbacks = {
  onSent?: (update: WatchContextUpdate, idx: NativeMessageIdx) => void;
  onChanged?: () => void;
};

/** Per-core agent view of watched resources. Owns one connection per watcher
 * and caches the latest pushed state, so the request path never waits on a
 * socket. Agent-seen blobs are keyed by native message idx, like `GitTracker`. */
export class WatchSupervisor implements ToolLoopSupervisor {
  callbacks: WatchSupervisorCallbacks = {};
  private readonly tracked = new Map<string, Tracked>();
  private readonly connections = new Map<string, ConnectionSlot>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly dormancyTimer: ReturnType<typeof setInterval>;
  private dormant = false;
  private disposed = false;

  private constructor(
    private readonly registry: WatcherRegistry,
    private readonly getLastAttention: () => number,
    private readonly histories: Map<string, ViewEntry[]>,
    private readonly untracked: Set<string>,
    private readonly now: () => number,
  ) {
    this.dormant = this.isDormantNow();
    this.dormancyTimer = setInterval(
      () => this.noteAttention(),
      DORMANCY_CHECK_MS,
    );
    this.dormancyTimer.unref?.();
  }

  static create(args: {
    registry: WatcherRegistry;
    getLastAttention?: () => number;
    /** From a replaced core: `seen` is what the agent already has, so it is
     * not re-delivered. */
    track?: ReadonlyArray<WatchSeed>;
    now?: () => number;
  }): WatchSupervisor {
    const histories = new Map<string, ViewEntry[]>();
    for (const r of args.track ?? []) {
      if (r.seen !== undefined) {
        histories.set(refId(r), [
          { nativeMessageIdx: 0 as NativeMessageIdx, context: r.seen },
        ]);
      }
    }
    const s = new WatchSupervisor(
      args.registry,
      args.getLastAttention ?? Date.now,
      histories,
      new Set(),
      args.now ?? Date.now,
    );
    for (const r of args.track ?? []) s.track(r);
    return s;
  }

  /** Keeps the agent view as of `nativeMessageIdx`; opens fresh connections. */
  static clone(args: {
    source: WatchSupervisor;
    nativeMessageIdx: NativeMessageIdx;
  }): WatchSupervisor {
    const histories = new Map<string, ViewEntry[]>();
    for (const [id, history] of args.source.histories) {
      const kept = history.filter(
        (e) => e.nativeMessageIdx <= args.nativeMessageIdx,
      );
      if (kept.length) histories.set(id, kept);
    }
    const s = new WatchSupervisor(
      args.source.registry,
      args.source.getLastAttention,
      histories,
      new Set(args.source.untracked),
      args.source.now,
    );
    for (const t of args.source.tracked.values()) {
      if (histories.has(refId(t))) s.track(t);
    }
    return s;
  }

  track(ref: ResourceRef): void {
    const id = refId(ref);
    if (this.disposed || this.tracked.has(id) || this.untracked.has(id)) return;
    this.tracked.set(id, {
      watcher: ref.watcher,
      key: ref.key,
      latest: undefined,
      subscribed: false,
    });
    if (!this.dormant) this.subscribe(id);
    this.callbacks.onChanged?.();
  }

  untrack(ref: ResourceRef): void {
    const id = refId(ref);
    this.untracked.add(id);
    const t = this.tracked.get(id);
    if (!t) return;
    this.tracked.delete(id);
    if (t.subscribed) this.openConnection(t.watcher)?.unsubscribe(t.key);
    this.callbacks.onChanged?.();
  }

  get trackedResources(): ReadonlyArray<ResourceRef> {
    return [...this.tracked.values()].map(({ watcher, key }) => ({
      watcher,
      key,
    }));
  }
  /** Seed for a replacement core. */
  get seeds(): ReadonlyArray<WatchSeed> {
    return this.trackedResources.map((r) => {
      const seen = this.getAgentView(r);
      return seen !== undefined ? { ...r, seen } : r;
    });
  }

  /** Re-evaluates dormancy: subscribes on attention, unsubscribes when idle. */
  noteAttention(): void {
    if (this.disposed) return;
    const dormant = this.isDormantNow();
    if (dormant === this.dormant) return;
    this.dormant = dormant;
    for (const [id, t] of this.tracked) {
      if (dormant && t.subscribed) {
        t.subscribed = false;
        this.openConnection(t.watcher)?.unsubscribe(t.key);
      } else if (!dormant && !t.subscribed) {
        this.subscribe(id);
      }
    }
    this.callbacks.onChanged?.();
  }

  getViewState(): WatchedResourceView[] {
    return [...this.tracked.entries()].map(([id, t]) => ({
      watcher: t.watcher,
      key: t.key,
      state: t.latest,
      paused: this.dormant,
      pendingUpdate: this.pendingFor(id, t) !== undefined,
    }));
  }

  /** The blob the agent last saw for `ref`. */
  getAgentView(ref: ResourceRef): string | undefined {
    return this.histories.get(refId(ref))?.at(-1)?.context;
  }

  private isDormantNow(): boolean {
    return this.now() - this.getLastAttention() >= WATCH_DORMANT_AFTER_MS;
  }

  private openConnection(watcher: string): WatcherConnection | undefined {
    const slot = this.connections.get(watcher);
    return slot?.type === "open" ? slot.connection : undefined;
  }

  private connection(watcher: string): Promise<WatcherConnection | undefined> {
    const slot = this.connections.get(watcher);
    if (slot?.type === "open") return Promise.resolve(slot.connection);
    if (slot) return slot.promise;
    const promise = this.registry.connect(watcher).then(
      (connection) => {
        if (this.disposed) {
          connection.close();
          return undefined;
        }
        this.connections.set(watcher, { type: "open", connection });
        connection.onState((state) => this.applyState(watcher, state));
        connection.onClose(() => this.handleClose(watcher, connection));
        return connection;
      },
      (e: unknown) => {
        this.connections.delete(watcher);
        this.markUnavailable(
          watcher,
          `watcher unreachable: ${e instanceof Error ? e.message : String(e)}`,
        );
        return undefined;
      },
    );
    this.connections.set(watcher, { type: "connecting", promise });
    return promise;
  }

  private subscribe(id: string): void {
    const t = this.tracked.get(id);
    if (!t) return;
    t.subscribed = true;
    void this.connection(t.watcher).then(async (connection) => {
      if (!connection || this.tracked.get(id) !== t || !t.subscribed) return;
      try {
        this.applyState(t.watcher, await connection.subscribe(t.key));
      } catch (e) {
        if (this.disposed || this.openConnection(t.watcher) !== connection)
          return;
        t.latest = {
          key: t.key,
          status: "unavailable",
          context: t.latest?.context ?? "",
          summary: t.latest?.summary ?? "",
          error: e instanceof Error ? e.message : String(e),
        };
        this.callbacks.onChanged?.();
      }
    });
  }

  private markUnavailable(watcher: string, error: string): void {
    for (const t of this.tracked.values()) {
      if (t.watcher !== watcher || !t.subscribed) continue;
      t.subscribed = false;
      t.latest = {
        key: t.key,
        status: "unavailable",
        context: t.latest?.context ?? "",
        summary: t.latest?.summary ?? error,
        error,
      };
    }
    this.callbacks.onChanged?.();
  }

  private handleClose(watcher: string, connection: WatcherConnection): void {
    if (this.disposed || this.openConnection(watcher) !== connection) return;
    this.connections.delete(watcher);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.disposed || this.dormant) return;
      for (const [id, t] of this.tracked) {
        if (t.watcher === watcher && t.subscribed) this.subscribe(id);
      }
    }, RECONNECT_DELAY_MS);
    this.timers.add(timer);
  }

  private applyState(watcher: string, state: ResourceState): void {
    const t = this.tracked.get(refId({ watcher, key: state.key }));
    if (!t?.subscribed) return;
    t.latest = state;
    this.callbacks.onChanged?.();
  }

  private pendingFor(id: string, t: Tracked): WatchUpdate | undefined {
    const latest = t.latest?.context;
    if (latest === undefined) return undefined;
    const seen = this.histories.get(id)?.at(-1)?.context;
    if (seen === latest) return undefined;
    if (seen === undefined) {
      return latest
        ? { watcher: t.watcher, key: t.key, kind: "full", text: latest }
        : undefined;
    }
    return {
      watcher: t.watcher,
      key: t.key,
      kind: "diff",
      text: diffBlobs(seen, latest),
    };
  }

  private pendingUpdates(): Array<{
    id: string;
    context: string;
    update: WatchUpdate;
  }> {
    return [...this.tracked.entries()].flatMap(([id, t]) => {
      const update = this.pendingFor(id, t);
      return update && t.latest
        ? [{ id, context: t.latest.context, update }]
        : [];
    });
  }

  onBeforeRequest(context: RequestContext): Promise<SupervisorAction> {
    this.noteAttention();
    const pending = this.pendingUpdates();
    if (!pending.length) return Promise.resolve({ type: "none" });
    for (const p of pending) {
      const history = this.histories.get(p.id) ?? [];
      const last = history.at(-1);
      if (last && context.nativeMessageIdx < last.nativeMessageIdx) {
        throw new Error(
          `Watch history must be monotonic: ${context.nativeMessageIdx} < ${last.nativeMessageIdx}`,
        );
      }
      history.push({
        nativeMessageIdx: context.nativeMessageIdx,
        context: p.context,
      });
      this.histories.set(p.id, history);
    }
    const update = { resources: pending.map((p) => p.update) };
    this.callbacks.onSent?.(update, context.nativeMessageIdx);
    return Promise.resolve(injectText(watchUpdateToText(update)));
  }

  hasPendingContent(): Promise<boolean> {
    return Promise.resolve(this.pendingUpdates().length > 0);
  }

  dispose(): void {
    this.disposed = true;
    this.callbacks = {};
    clearInterval(this.dormancyTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const slot of this.connections.values()) {
      if (slot.type === "open") slot.connection.close();
    }
    this.connections.clear();
  }
}
