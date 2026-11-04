/**
 * Canonical watcher protocol types. Self-contained (node built-ins only) so a
 * watcher or wait script can use the sdk without the rest of magenta.
 * `node/server/src/watchers/protocol.ts` mirrors these with runtime parsers.
 *
 * Framing: one JSON-RPC 2.0 message per line over a unix socket.
 * Requests: hello, scan, subscribe, unsubscribe, get, list.
 * Notification watcher -> client: state(ResourceState).
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROTOCOL_VERSION = 1;

export type Manifest = {
  name: string;
  protocolVersion: 1;
  /** Run with cwd = the manifest's directory. */
  command: string[];
  /** Defaults to ~/.magenta/watchers/<name>.sock */
  socket?: string;
};

export type HelloResult = { name: string; protocolVersion: 1 };
export type SubscribeParams = { key: string; filter?: unknown };
export type UnsubscribeParams = { key: string };
export type GetParams = { key: string; filter?: unknown };
/** Pure: returns the canonical keys found in `texts`; starts no polling. */
export type ScanParams = { texts: string[] };
export type ScanResult = { keys: string[] };

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/")
    ? path.join(os.homedir(), p.slice(1))
    : p;
}

export type LoadedManifest = Manifest & { dir: string; socketPath: string };

export function readManifest(manifestPath: string): LoadedManifest {
  const file = path.resolve(expandHome(manifestPath));
  const parsed = parseManifestObject(JSON.parse(readFileSync(file, "utf8")));
  if (parsed.status === "error") {
    throw new Error(`invalid watcher manifest ${file}: ${parsed.error}`);
  }
  const manifest = parsed.value;
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

export type ResourceStatus =
  | "loading"
  | "active"
  | "failing"
  | "unavailable"
  | "finished";
type ResourceStateBase = {
  key: string;
  /** Agent-facing rendering; magenta diffs successive blobs. */
  context: string;
  /** One line for the sidebar. */
  summary: string;
  /** Multi-line expanded sidebar view. */
  details?: string;
};
export type ResourceState = ResourceStateBase &
  (
    | { status: "loading" | "active" | "finished" }
    | { status: "failing" | "unavailable"; error: string }
  );
export type JsonRpcId = number | string;
export type JsonRpcMessage =
  | { kind: "request"; id: JsonRpcId; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "result"; id: JsonRpcId; result: unknown }
  | {
      kind: "error";
      /** undefined when the wire id was null (e.g. a parse error). */
      id: JsonRpcId | undefined;
      error: { code: number; message: string };
    };

const STATUSES: readonly ResourceStatus[] = [
  "loading",
  "active",
  "failing",
  "unavailable",
  "finished",
];
function isResourceStatus(v: unknown): v is ResourceStatus {
  return STATUSES.some((s) => s === v);
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((c) => typeof c === "string");
}
function isJsonRpcId(v: unknown): v is JsonRpcId {
  return typeof v === "number" || typeof v === "string";
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseManifestObject(
  raw: unknown,
): { status: "ok"; value: Manifest } | { status: "error"; error: string } {
  const fail = (error: string) => ({ status: "error" as const, error });
  if (!isPlainObject(raw)) return fail("manifest must be an object");
  if (typeof raw.name !== "string" || !/^[\w.-]+$/.test(raw.name)) {
    return fail("name must be a non-empty string of [A-Za-z0-9_.-]");
  }
  if (raw.protocolVersion !== PROTOCOL_VERSION) {
    return fail(`protocolVersion must be ${PROTOCOL_VERSION}`);
  }
  if (!isStringArray(raw.command) || raw.command.length === 0) {
    return fail("command must be a non-empty string array");
  }
  if (raw.socket !== undefined && typeof raw.socket !== "string") {
    return fail("socket must be a string");
  }
  const manifest: Manifest = {
    name: raw.name,
    protocolVersion: PROTOCOL_VERSION,
    command: raw.command,
  };
  if (typeof raw.socket === "string") manifest.socket = raw.socket;
  return { status: "ok", value: manifest };
}

export function parseResourceState(raw: unknown): ResourceState | undefined {
  if (!isPlainObject(raw)) return undefined;
  const { key, status, context, summary, details, error } = raw;
  if (typeof key !== "string" || !isResourceStatus(status)) return undefined;
  if (typeof context !== "string" || typeof summary !== "string") {
    return undefined;
  }
  if (details !== undefined && typeof details !== "string") return undefined;
  const base: ResourceStateBase = { key, context, summary };
  if (typeof details === "string") base.details = details;
  if (status === "failing" || status === "unavailable") {
    if (typeof error !== "string") return undefined;
    return { ...base, status, error };
  }
  if (error !== undefined) return undefined;
  return { ...base, status };
}

/** Parses one NDJSON line into a JSON-RPC 2.0 message. */
export function parseJsonRpcLine(line: string): JsonRpcMessage | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isPlainObject(raw) || raw.jsonrpc !== "2.0") return undefined;
  const id = raw.id;
  if (typeof raw.method === "string") {
    return isJsonRpcId(id)
      ? { kind: "request", id, method: raw.method, params: raw.params }
      : { kind: "notification", method: raw.method, params: raw.params };
  }
  if ("result" in raw && isJsonRpcId(id)) {
    return { kind: "result", id, result: raw.result };
  }
  if (
    isPlainObject(raw.error) &&
    typeof raw.error.code === "number" &&
    typeof raw.error.message === "string" &&
    (isJsonRpcId(id) || id === null)
  ) {
    return {
      kind: "error",
      id: isJsonRpcId(id) ? id : undefined,
      error: { code: raw.error.code, message: raw.error.message },
    };
  }
  return undefined;
}
