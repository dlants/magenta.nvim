/**
 * Magenta's side of the watcher protocol. The canonical types live in
 * `sdk/watchers/protocol.ts` (self-contained so watcher authors can copy the
 * sdk); these mirror them with runtime parsers, because watcher processes are
 * user code and their output is validated at the boundary.
 */

export const WATCHER_PROTOCOL_VERSION = 1;

export type WatcherTrigger = {
  pattern: string;
  flags?: string;
  keyGroup?: number;
};

export type WatcherManifest = {
  name: string;
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

export type ResourceState = {
  key: string;
  status: ResourceStatus;
  context: string;
  summary: string;
  details?: string;
  error?: string;
};

export type JsonRpcMessage =
  | { kind: "request"; id: number | string; method: string; params: unknown }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "result"; id: number | string; result: unknown }
  | {
      kind: "error";
      id: number | string | null;
      error: { code: number; message: string };
    };

const STATUSES: readonly string[] = [
  "loading",
  "active",
  "failing",
  "unavailable",
  "finished",
];

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
  if (
    !Array.isArray(raw.command) ||
    raw.command.length === 0 ||
    !raw.command.every((c) => typeof c === "string")
  ) {
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
    name: raw.name,
    protocolVersion: WATCHER_PROTOCOL_VERSION,
    command: raw.command as string[],
    triggers,
  };
  if (typeof raw.socket === "string") manifest.socket = raw.socket;
  return { status: "ok", value: manifest };
}

export function parseResourceState(raw: unknown): ResourceState | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.key !== "string") return undefined;
  if (typeof raw.status !== "string" || !STATUSES.includes(raw.status)) {
    return undefined;
  }
  if (typeof raw.context !== "string" || typeof raw.summary !== "string") {
    return undefined;
  }
  if (raw.details !== undefined && typeof raw.details !== "string") {
    return undefined;
  }
  if (raw.error !== undefined && typeof raw.error !== "string") {
    return undefined;
  }
  const state: ResourceState = {
    key: raw.key,
    status: raw.status as ResourceStatus,
    context: raw.context,
    summary: raw.summary,
  };
  if (typeof raw.details === "string") state.details = raw.details;
  if (typeof raw.error === "string") state.error = raw.error;
  return state;
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
  const validId = typeof id === "number" || typeof id === "string";
  if (typeof raw.method === "string") {
    return validId
      ? { kind: "request", id, method: raw.method, params: raw.params }
      : { kind: "notification", method: raw.method, params: raw.params };
  }
  if ("result" in raw && validId) {
    return { kind: "result", id, result: raw.result };
  }
  if (
    isPlainObject(raw.error) &&
    typeof raw.error.code === "number" &&
    typeof raw.error.message === "string" &&
    (validId || id === null)
  ) {
    return {
      kind: "error",
      id: validId ? id : null,
      error: { code: raw.error.code, message: raw.error.message },
    };
  }
  return undefined;
}
