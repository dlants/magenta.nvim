import type {
  MagentaServer,
  ProtocolScriptState,
  ProtocolSessionState,
  ScriptInvocationId,
  SessionId,
  ThreadId,
} from "@magenta/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { Chat } from "../chat/chat.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { MagentaOptions } from "../options.ts";
import type { RootMsg } from "../root-msg.ts";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import { ScriptController } from "./script-manager.ts";

const notifyUser = vi.hoisted(() => vi.fn());
vi.mock("../chat/notify.ts", () => ({ notifyUser }));

beforeEach(() => notifyUser.mockReset());

type Listener = (state: unknown) => void;

function fakeServer() {
  const listeners = new Map<string, Listener>();
  const unsubscribed: string[] = [];
  const key = (topic: { type: string; invocationId?: string }) =>
    topic.type === "script" ? `script:${topic.invocationId}` : topic.type;
  const server = {
    subscribe(topic: { type: string; invocationId?: string }, l: Listener) {
      const k = key(topic);
      listeners.set(k, l);
      return () => {
        listeners.delete(k);
        unsubscribed.push(k);
      };
    },
    execute: vi.fn(() => Promise.resolve({ type: "ok" })),
  } as unknown as MagentaServer;
  const push = (k: string, state: unknown) => listeners.get(k)?.(state);
  return { server, listeners, unsubscribed, push };
}

const sessionWith = (ids: string[]) =>
  ({
    scripts: { catalog: [], invocations: ids.map((id) => ({ id })) },
  }) as unknown as ProtocolSessionState;

const script = (
  id: string,
  type: "running" | "done",
  threadIds: string[] = [],
): ProtocolScriptState => ({
  id: id as ScriptInvocationId,
  scriptName: `script-${id}`,
  file: `/f/${id}.ts`,
  parameters: {},
  state: { type },
  threadIds: threadIds as ThreadId[],
  sandboxBypassed: false,
  logs: [],
  entries: [],
  threadYields: {},
});

function setup(initialIds: string[]) {
  const fake = fakeServer();
  const dispatched: RootMsg[] = [];
  // Deliver the first session state synchronously, as the real server does.
  const subscribe = fake.server.subscribe.bind(fake.server);
  (fake.server as { subscribe: unknown }).subscribe = (
    topic: { type: string },
    l: Listener,
  ) => {
    const un = subscribe(topic as never, l as never);
    if (topic.type === "session") l(sessionWith(initialIds));
    return un;
  };
  const controller = new ScriptController({
    dispatch: (msg) => dispatched.push(msg),
    chat: {
      isScriptDeleted: () => false,
      dropDeleted: () => {},
    } as unknown as Chat,
    server: fake.server,
    sessionId: "s" as SessionId,
    nvim: { logger: { error: vi.fn() } } as unknown as Nvim,
    cwd: "/" as NvimCwd,
    homeDir: "/" as HomeDir,
    getOptions: () => ({}) as MagentaOptions,
  });
  return { ...fake, controller, dispatched };
}

const render = (c: ScriptController) => JSON.stringify(c.view());

it("does not notify for invocations already finished at startup", () => {
  const t = setup(["a"]);
  t.push("script:a", script("a", "done"));
  expect(notifyUser).not.toHaveBeenCalled();
});

it("notifies for a late invocation whose first state is finished", () => {
  const t = setup([]);
  t.push("session", sessionWith(["b"]));
  t.push("script:b", script("b", "done"));
  expect(notifyUser).toHaveBeenCalledTimes(1);
});

it("notifies once on running -> done", () => {
  const t = setup(["c"]);
  t.push("script:c", script("c", "running"));
  t.push("script:c", script("c", "done"));
  t.push("script:c", script("c", "done"));
  expect(notifyUser).toHaveBeenCalledTimes(1);
});

it("session state with the same ids does not dispatch", () => {
  const t = setup(["a"]);
  t.dispatched.length = 0;
  t.push("session", sessionWith(["a"]));
  expect(t.dispatched).toEqual([]);
});

for (const how of ["script undefined", "session removal"] as const) {
  it(`drops an invocation on ${how}`, () => {
    const t = setup(["a"]);
    t.push("script:a", script("a", "running", ["t1"]));
    t.controller.update({
      type: "script-msg",
      msg: { type: "toggle-invocation-expand", id: "a" as ScriptInvocationId },
    });
    t.controller.update({
      type: "script-msg",
      msg: { type: "toggle-thread-yield", id: "t1" as ThreadId },
    });
    expect(render(t.controller)).toContain("script-a");

    if (how === "script undefined") t.push("script:a", undefined);
    else t.push("session", sessionWith([]));

    expect(t.unsubscribed).toContain("script:a");
    expect(t.listeners.has("script:a")).toBe(false);
    const internals = t.controller as unknown as {
      expandedInvocations: Set<string>;
      expandedThreads: Set<string>;
    };
    expect(internals.expandedInvocations.size).toBe(0);
    expect(internals.expandedThreads.size).toBe(0);
    expect(render(t.controller)).not.toContain("script-a");
  });
}

it("dispose unsubscribes everything", () => {
  const t = setup(["a", "b"]);
  t.controller.dispose();
  expect(t.listeners.size).toBe(0);
});
