/**
 * Magenta's side of the watcher protocol. Mirrors `sdk/watchers/protocol.ts`
 * (self-contained so watcher authors can copy the sdk); watcher processes are
 * user code, so their output is validated at the boundary.
 */
export const WATCHER_PROTOCOL_VERSION = 1;
export type WatcherTrigger = {
  pattern: string;
  flags?: string;
  keyGroup?: number;
};
export type WatcherName = string & { __watcherName: true };
export type WatcherManifest = {
  name: WatcherName;
  protocolVersion: 1;
  command: string[];
  socket?: string;
  triggers: WatcherTrigger[];
};
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

export function parseWatcherManifest(
  raw: unknown,
):
  | { status: "ok"; value: WatcherManifest }
  | { status: "error"; error: string } {
  const fail = (error: string) => ({ status: "error" as const, error });
  if (!isPlainObject(raw)) return fail("manifest must be an object");
  if (typeof raw.name !== "string" || !/^[\w.-]+$/.test(raw.name)) {
    return fail("name must be a non-empty string of [A-Za-z0-9_.-]");
  }
  if (raw.protocolVersion !== WATCHER_PROTOCOL_VERSION) {
    return fail(`protocolVersion must be ${WATCHER_PROTOCOL_VERSION}`);
  }
  if (!isStringArray(raw.command) || raw.command.length === 0) {
    return fail("command must be a non-empty string array");
  }
  if (raw.socket !== undefined && typeof raw.socket !== "string") {
    return fail("socket must be a string");
  }
  if (!Array.isArray(raw.triggers)) return fail("triggers must be an array");
  const triggers: WatcherTrigger[] = [];
  for (const t of raw.triggers) {
    if (!isPlainObject(t) || typeof t.pattern !== "string") {
      return fail("each trigger needs a string pattern");
    }
    if (t.flags !== undefined && typeof t.flags !== "string") {
      return fail("trigger flags must be a string");
    }
    if (t.keyGroup !== undefined && !Number.isInteger(t.keyGroup)) {
      return fail("trigger keyGroup must be an integer");
    }
    try {
      new RegExp(t.pattern, typeof t.flags === "string" ? t.flags : "");
    } catch (e) {
      return fail(`invalid trigger pattern: ${(e as Error).message}`);
    }
    const trigger: WatcherTrigger = { pattern: t.pattern };
    if (typeof t.flags === "string") trigger.flags = t.flags;
    if (typeof t.keyGroup === "number") trigger.keyGroup = t.keyGroup;
    triggers.push(trigger);
  }
  const manifest: WatcherManifest = {
    name: raw.name as WatcherName,
    protocolVersion: WATCHER_PROTOCOL_VERSION,
    command: raw.command,
    triggers,
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
