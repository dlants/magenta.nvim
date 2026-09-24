import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ScriptManager,
  type ThreadId,
  type ToolName,
  type ToolRequestId,
} from "@magenta/server";
import {
  createHarness,
  type Harness,
} from "@magenta/server/src/test/harness.ts";
import { noopLogger } from "@magenta/server/src/test-helpers.ts";
import type { HomeDir, NvimCwd } from "@magenta/server/src/utils/files.ts";
import { expect, it } from "vitest";
import { BUILTIN_SDK_PATH } from "../options.ts";

async function writeScript(root: string, body: string): Promise<void> {
  const pkgDir = path.join(root, ".magenta", "scripts", "pkg");
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(path.join(pkgDir, "index.ts"), body);
  await fs.symlink(BUILTIN_SDK_PATH, path.join(pkgDir, "magenta-sdk"));
}

async function pollUntil(fn: () => boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("pollUntil timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function expectInvocation(
  scripts: ScriptManager,
  id: Parameters<ScriptManager["childPid"]>[0],
) {
  const inv = scripts.invocations.get(id);
  if (!inv) throw new Error(`no invocation ${id}`);
  return inv;
}

function expectChildPid(
  scripts: ScriptManager,
  id: Parameters<ScriptManager["childPid"]>[0],
): number {
  const pid = scripts.childPid(id);
  if (pid === undefined) throw new Error(`no child pid for ${id}`);
  return pid;
}

function loggedChildPid(logs: readonly string[]): string {
  const line = logs.find((l) => l.startsWith("child "));
  if (!line) throw new Error(`no "child " log line in ${JSON.stringify(logs)}`);
  return line.slice("child ".length);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const FOO_SCRIPT = `
import { registerScript } from "./magenta-sdk/index.ts";

registerScript(
  "foo",
  "does foo",
  { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
  async (params, thread, log) => {
    log("starting");
    const r = await thread("work on " + params.x, {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    });
    log("got " + JSON.stringify(r));
  },
);
`;

const CONTEXT_SCRIPT = `
import { registerScript } from "./magenta-sdk/index.ts";

registerScript(
  "ctx",
  "spawns a thread with a context file and a system reminder",
  { type: "object", properties: {}, required: [] },
  async (_params, thread, log) => {
    await thread(
      "do the work",
      { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      { contextFiles: ["seed.txt"], systemReminder: "REMEMBER_SENTINEL_XYZ" },
    );
    log("done");
  },
);
`;

const CRASH_SCRIPT = `
import { registerScript } from "./magenta-sdk/index.ts";

registerScript(
  "foo",
  "throws",
  { type: "object", properties: {}, required: [] },
  async (_params, _thread, log) => {
    log("starting");
    throw new Error("boom");
  },
);
`;

const LONG_LIVED_SCRIPT = `
import { registerScript } from "./magenta-sdk/index.ts";
import { spawn } from "node:child_process";

registerScript(
  "foo",
  "spawns a long-lived child",
  { type: "object", properties: {}, required: [] },
  async (_params, _thread, log) => {
    const child = spawn("sleep", ["120"], { detached: false });
    log("child " + child.pid);
    await new Promise((r) => setTimeout(r, 60000));
  },
);
`;

type Fixture = {
  h: Harness;
  scripts: ScriptManager;
  cwd: string;
  bypassed: Set<ThreadId>;
};

/** Tier B: real script files and child processes, over the node-only harness
 * session (in-memory FileIO for the spawned threads). */
async function withScripts(
  setup: { project?: string; home?: string; files?: Record<string, string> },
  fn: (f: Fixture) => Promise<void>,
): Promise<void> {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "magenta-scripts-")),
  );
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  await fs.mkdir(cwd);
  await fs.mkdir(home);
  if (setup.project) await writeScript(cwd, setup.project);
  if (setup.home) await writeScript(home, setup.home);
  const files: Record<string, string> = {};
  for (const [rel, content] of Object.entries(setup.files ?? {})) {
    files[path.join(cwd, rel)] = content;
  }
  const h = createHarness({ cwd, homeDir: home, files });
  const bypassed = new Set<ThreadId>();
  const scripts = new ScriptManager({
    session: h.session,
    logger: noopLogger,
    cwd: cwd as NvimCwd,
    homeDir: home as HomeDir,
    getScriptsPaths: () => ["~/.magenta/scripts", ".magenta/scripts"],
    sandbox: {
      isThreadBypassed: (id) => bypassed.has(id),
      registerSandboxRoot: () => {},
      approveAllPendingInSubtree: () => {},
    },
  });
  h.session.scriptRunner = scripts;
  try {
    await scripts.discover();
    await fn({ h, scripts, cwd, bypassed });
  } finally {
    await scripts.dispose();
    await h.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function yieldOk(id: string) {
  return {
    stopReason: "tool_use" as const,
    text: "done",
    toolRequests: [
      {
        status: "ok" as const,
        value: {
          id: id as ToolRequestId,
          toolName: "yield_to_parent" as ToolName,
          input: { ok: true },
        },
      },
    ],
  };
}

function runScriptResponse(input: Record<string, unknown>) {
  return {
    stopReason: "tool_use" as const,
    text: "running the script",
    toolRequests: [
      {
        status: "ok" as const,
        value: {
          id: "run-1" as ToolRequestId,
          toolName: "run_script" as ToolName,
          input,
        },
      },
    ],
  };
}

it("discovers via index.ts and ignores sibling library files", async () => {
  await withScripts({ project: FOO_SCRIPT }, async ({ scripts, cwd }) => {
    await fs.writeFile(
      path.join(cwd, ".magenta", "scripts", "pkg", "shared-lib.ts"),
      "export const helper = () => 42;\n",
    );
    await scripts.discover();
    expect(scripts.getCatalog().map((s) => s.name)).toEqual(["foo"]);
  });
});

it("discovers scripts from the global ~/.magenta/scripts path", async () => {
  await withScripts({ home: FOO_SCRIPT }, async ({ scripts }) => {
    expect(scripts.getCatalog().map((s) => s.name)).toEqual(["foo"]);
  });
});

it("invokes a script that spawns a thread and resolves with the structured yield", async () => {
  await withScripts({ project: FOO_SCRIPT }, async ({ h, scripts }) => {
    const id = scripts.startScript(
      "foo",
      { x: "thing" },
      { sandboxBypassed: false },
    );
    (await h.streamWithText("work on thing")).respond(yieldOk("yield-1"));
    const inv = expectInvocation(scripts, id);
    await pollUntil(() => inv.state.type === "done");
    expect(inv.threadIds.length).toBe(1);
    expect(inv.logs).toContain("starting");
    expect(inv.logs.some((l) => l.includes('"ok":true'))).toBe(true);
    expect(scripts.getThreadYield(inv.threadIds[0])).toEqual({
      status: "ok",
      value: { ok: true },
    });
  });
});

it("does not resolve a script's createThread() await on a subagent error", async () => {
  await withScripts({ project: FOO_SCRIPT }, async ({ h, scripts }) => {
    const id = scripts.startScript(
      "foo",
      { x: "thing" },
      { sandboxBypassed: false },
    );
    const stream = await h.streamWithText("work on thing");
    stream.respondWithError(new Error("Simulated subagent error"));
    const inv = expectInvocation(scripts, id);
    await pollUntil(() => inv.threadIds.length > 0);
    const thread = h.thread(inv.threadIds[0]);
    await pollUntil(() => thread.lastResult()?.type === "failed");

    await new Promise((r) => setTimeout(r, 100));
    expect(inv.state.type).toBe("running");

    void h.send(thread, "work on thing");
    await pollUntil(() =>
      h.mockClient.streams.some((s) => s !== stream && !s.resolved),
    );
    h.mockClient.streams
      .find((s) => s !== stream && !s.resolved)!
      .respond(yieldOk("yield-retry"));
    await pollUntil(() => inv.state.type === "done");
    expect(inv.logs.some((l) => l.includes('"ok":true'))).toBe(true);
  });
});

it("passes contextFiles and systemReminder through to the spawned thread", async () => {
  await withScripts(
    {
      project: CONTEXT_SCRIPT,
      files: { "seed.txt": "SEED_CONTENT_SENTINEL\n" },
    },
    async ({ h, scripts }) => {
      scripts.startScript("ctx", {}, { sandboxBypassed: false });
      const stream = await h.streamWithText("SEED_CONTENT_SENTINEL");
      // The custom reminder rides the standing reminder, gated on output
      // tokens: it goes out on the first request past the interval.
      stream.respond({
        stopReason: "tool_use",
        text: "thinking out loud",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "read-seed" as ToolRequestId,
              toolName: "get_files" as ToolName,
              input: { files: [{ filePath: "./seed.txt" }] },
            },
          },
        ],
        usage: { inputTokens: 10, outputTokens: 5000 },
      });
      await h.streamWithText("REMEMBER_SENTINEL_XYZ");
    },
  );
});

it("marks the invocation error when the runner throws", async () => {
  await withScripts({ project: CRASH_SCRIPT }, async ({ scripts }) => {
    const id = scripts.startScript("foo", {}, { sandboxBypassed: false });
    await pollUntil(() => scripts.invocations.get(id)?.state.type === "error");
    expect(scripts.invocations.get(id)?.logs).toContain("error: boom");
  });
});

it("group-kills the subprocess tree on terminate", async () => {
  await withScripts({ project: LONG_LIVED_SCRIPT }, async ({ scripts }) => {
    const id = scripts.startScript("foo", {}, { sandboxBypassed: false });
    const inv = expectInvocation(scripts, id);
    await pollUntil(() => inv.logs.some((l) => l.startsWith("child ")));
    const childPid = expectChildPid(scripts, id);
    const grandchildPid = Number(loggedChildPid(inv.logs));
    expect(isAlive(childPid)).toBe(true);
    expect(isAlive(grandchildPid)).toBe(true);
    scripts.terminateAll();
    await pollUntil(() => !isAlive(childPid) && !isAlive(grandchildPid));
  });
});

it("lets an in-magenta agent trigger a script via run_script", async () => {
  await withScripts({ project: FOO_SCRIPT }, async ({ h, scripts }) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "please run foo");
    (await h.nextStream()).respond(
      runScriptResponse({ scriptName: "foo", parameters: { x: "thing" } }),
    );
    await pollUntil(() => scripts.invocations.size > 0);
    const inv = [...scripts.invocations.values()][0];
    (await h.streamWithText("work on thing")).respond(yieldOk("yield-1"));
    await pollUntil(() => inv.state.type === "done");
    expect(inv.scriptName).toBe("foo");
  });
});

it("returns the script's parameter schema when run_script is called without parameters", async () => {
  await withScripts({ project: FOO_SCRIPT }, async ({ h, scripts }) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "what params does foo take?");
    (await h.nextStream()).respond(runScriptResponse({ scriptName: "foo" }));
    const next = await h.nextStream();
    expect(JSON.stringify(next.messages)).toContain('\\"required\\"');
    expect(scripts.invocations.size).toBe(0);
  });
});

it("seeds the invocation as bypassed when triggered from a sandbox-disabled thread", async () => {
  await withScripts(
    { project: FOO_SCRIPT },
    async ({ h, scripts, bypassed }) => {
      const { id, thread } = await h.createRoot();
      bypassed.add(id);
      void h.send(thread, "please run foo");
      (await h.nextStream()).respond(
        runScriptResponse({ scriptName: "foo", parameters: { x: "thing" } }),
      );
      await pollUntil(() => scripts.invocations.size > 0);
      expect([...scripts.invocations.values()][0].sandboxBypassed).toBe(true);
    },
  );
});

it("keeps the script running after its triggering thread is deleted", async () => {
  await withScripts({ project: FOO_SCRIPT }, async ({ h, scripts }) => {
    const { id, thread } = await h.createRoot();
    void h.send(thread, "please run foo");
    (await h.nextStream()).respond(
      runScriptResponse({ scriptName: "foo", parameters: { x: "thing" } }),
    );
    await pollUntil(() => scripts.invocations.size > 0);
    const inv = [...scripts.invocations.values()][0];
    h.session.deleteThread(id);
    (await h.streamWithText("work on thing")).respond(yieldOk("yield-1"));
    await pollUntil(() => inv.state.type === "done");
  });
});

it("deleting an invocation mid-creation leaves no orphan script thread", async () => {
  await withScripts({ project: FOO_SCRIPT }, async ({ h, scripts }) => {
    // Hold preparation open so the delete lands while the thread is pending.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.host.intercept = async (_request, prepare) => {
      await gate;
      return prepare();
    };
    const id = scripts.startScript(
      "foo",
      { x: "thing" },
      { sandboxBypassed: false },
    );
    await pollUntil(() =>
      h.session
        .listThreads()
        .some((t) => t.scriptInvocationId === id && t.state === "pending"),
    );
    scripts.deleteInvocation(id);
    release();
    expect(scripts.invocations.get(id)).toBeUndefined();
    await pollUntil(
      () => !h.session.listThreads().some((t) => t.scriptInvocationId === id),
    );
  });
});

it("dispose terminates running invocations and rejects new ones", async () => {
  await withScripts({ project: LONG_LIVED_SCRIPT }, async ({ scripts }) => {
    const id = scripts.startScript("foo", {}, { sandboxBypassed: false });
    const inv = expectInvocation(scripts, id);
    await pollUntil(() => inv.logs.some((l) => l.startsWith("child ")));
    const childPid = expectChildPid(scripts, id);
    const grandchildPid = Number(loggedChildPid(inv.logs));
    await scripts.dispose();
    await pollUntil(() => !isAlive(childPid) && !isAlive(grandchildPid));
    expect(() =>
      scripts.startScript("foo", {}, { sandboxBypassed: false }),
    ).toThrow("ScriptManager disposed");
    await scripts.discover();
    expect(scripts.getCatalog().length).toBe(0);
  });
});
