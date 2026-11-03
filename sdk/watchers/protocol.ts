/**
 * Canonical watcher protocol types. Self-contained (node built-ins only) so a
 * watcher or wait script can use the sdk without the rest of magenta.
 * `node/server/src/watchers/protocol.ts` mirrors these with runtime parsers.
 *
 * Framing: one JSON-RPC 2.0 message per line over a unix socket.
 * Requests: hello, subscribe, unsubscribe, get, list.
 * Notification watcher -> client: state(ResourceState).
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROTOCOL_VERSION = 1;

export type Trigger = { pattern: string; flags?: string; keyGroup?: number };

export type Manifest = {
  name: string;
  protocolVersion: 1;
  /** Run with cwd = the manifest's directory. */
  command: string[];
  /** Defaults to ~/.magenta/watchers/<name>.sock */
  socket?: string;
  triggers: Trigger[];
};

export type ResourceStatus =
  | "loading"
  | "active"
  | "failing"
  | "unavailable"
  | "finished";

export type ResourceState = {
  key: string;
  status: ResourceStatus;
  /** Agent-facing rendering; magenta diffs successive blobs. */
  context: string;
  /** One line for the sidebar. */
  summary: string;
  /** Multi-line expanded sidebar view. */
  details?: string;
  error?: string;
};

export type HelloResult = { name: string; protocolVersion: 1 };
export type SubscribeParams = { key: string; filter?: unknown };
export type UnsubscribeParams = { key: string };
export type GetParams = { key: string; filter?: unknown };

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
};
export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};
export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: number | string; result: unknown }
  | {
      jsonrpc: "2.0";
      id: number | string | null;
      error: { code: number; message: string };
    };

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/")
    ? path.join(os.homedir(), p.slice(1))
    : p;
}

export type LoadedManifest = Manifest & { dir: string; socketPath: string };

export function readManifest(manifestPath: string): LoadedManifest {
  const file = path.resolve(expandHome(manifestPath));
  const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
  const dir = path.dirname(file);
  const socket = manifest.socket ?? `~/.magenta/watchers/${manifest.name}.sock`;
  return {
    ...manifest,
    dir,
    socketPath: path.resolve(dir, expandHome(socket)),
  };
}

/** Splits a stream of chunks into lines, calling `onLine` per complete line. */
export function lineSplitter(onLine: (line: string) => void) {
  let buffer = "";
  return (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) onLine(line);
      idx = buffer.indexOf("\n");
    }
  };
}
