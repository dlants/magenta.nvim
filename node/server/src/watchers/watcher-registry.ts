import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../logger.ts";
import { expandTilde, type HomeDir } from "../utils/files.ts";
import {
  parseWatcherManifest,
  type ResourceState,
  type WatcherManifest,
  type WatcherName,
} from "./protocol.ts";

export type LoadedWatcherManifest = WatcherManifest & {
  /** Absolute dir of the manifest; the command runs here. */
  dir: string;
  socketPath: string;
};

export type ResourceRef = { watcher: WatcherName; key: string };

export interface WatcherConnection {
  subscribe(key: string, filter?: unknown): Promise<ResourceState>;
  unsubscribe(key: string): void;
  onState(cb: (state: ResourceState) => void): void;
  /** Fired once, when the connection drops (including after `close`). */
  onClose(cb: () => void): void;
  close(): void;
}

/** Connect-or-spawn over the watcher's socket; faked in tests. */
export interface WatcherTransport {
  connect(manifest: LoadedWatcherManifest): Promise<WatcherConnection>;
}

export type WatcherTriggerMatcher = {
  watcher: WatcherName;
  regex: RegExp;
  keyGroup: number;
};

/** Session-owned: loads manifests from the user-level `watchers` option and
 * hands out connections. Subscriptions belong to the connections' owners. */
export class WatcherRegistry {
  private manifests = new Map<WatcherName, LoadedWatcherManifest>();
  private matchers: WatcherTriggerMatcher[] = [];

  constructor(
    private readonly opts: {
      transport: WatcherTransport;
      readFile?: (absPath: string) => Promise<string>;
      homeDir: HomeDir;
      logger: Logger;
    },
  ) {
    this.transport = opts.transport;
  }
  private transport: WatcherTransport;
  setTransportForTesting(transport: WatcherTransport): void {
    this.transport = transport;
  }

  /** Replaces the loaded set; an invalid manifest disables only that watcher. */
  async load(manifestPaths: ReadonlyArray<string>): Promise<void> {
    const manifests = new Map<WatcherName, LoadedWatcherManifest>();
    for (const p of manifestPaths) {
      const absPath = path.resolve(expandTilde(p, this.opts.homeDir));
      try {
        const parsed = parseWatcherManifest(
          JSON.parse(
            await (this.opts.readFile ?? ((p) => readFile(p, "utf8")))(absPath),
          ) as unknown,
        );
        if (parsed.status === "error") {
          this.opts.logger.error(
            `watcher manifest ${absPath}: ${parsed.error}`,
          );
          continue;
        }
        const manifest = parsed.value;
        const dir = path.dirname(absPath);
        const socket = manifest.socket
          ? path.resolve(dir, expandTilde(manifest.socket, this.opts.homeDir))
          : path.join(
              this.opts.homeDir,
              ".magenta",
              "watchers",
              `${manifest.name}.sock`,
            );
        manifests.set(manifest.name, { ...manifest, dir, socketPath: socket });
      } catch (e) {
        this.opts.logger.error(
          `watcher manifest ${absPath}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    this.setManifests([...manifests.values()]);
  }

  setManifests(manifests: ReadonlyArray<LoadedWatcherManifest>): void {
    this.manifests = new Map(manifests.map((m) => [m.name, m]));
    this.matchers = manifests.flatMap((m) =>
      m.triggers.map((t) => ({
        watcher: m.name,
        regex: new RegExp(
          t.pattern,
          (t.flags ?? "").includes("g") ? t.flags : `${t.flags ?? ""}g`,
        ),
        keyGroup: t.keyGroup ?? 0,
      })),
    );
  }

  triggers(): ReadonlyArray<WatcherTriggerMatcher> {
    return this.matchers;
  }

  connect(watcher: WatcherName): Promise<WatcherConnection> {
    const manifest = this.manifests.get(watcher);
    if (!manifest) {
      return Promise.reject(new Error(`unknown watcher ${watcher}`));
    }
    return this.transport.connect(manifest);
  }
}
