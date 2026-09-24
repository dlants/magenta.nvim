import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/server";
import { expect, it } from "vitest";
import { BUILTIN_SDK_PATH } from "../options.ts";
import { withDriver } from "../test/preamble.ts";
import type { ScriptInvocationId } from "./script-manager.ts";

// Magenta no longer manages the magenta-sdk shim; the user/agent is expected to
// create the `magenta-sdk` symlink when authoring a script package. Tests do
// the same here.
async function createSdkSymlink(pkgDir: string): Promise<void> {
  await fs.symlink(BUILTIN_SDK_PATH, path.join(pkgDir, "magenta-sdk"));
}

async function setupScript(tmpDir: string, body: string): Promise<void> {
  const pkgDir = path.join(tmpDir, ".magenta", "scripts", "pkg");
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(path.join(pkgDir, "index.ts"), body);
  await createSdkSymlink(pkgDir);
}

async function pollUntil(fn: () => boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("pollUntil timed out");
    }
    await new Promise((r) => setTimeout(r, 50));
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

it("renders running invocations, logs, and spawned threads in the Scripts overview section", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, FOO_SCRIPT);
      },
    },
    async (driver) => {
      await driver.showSidebar();
      const scriptManager = driver.magenta.scripts;
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

      const id = scriptManager.startScript(
        "foo",
        { x: "thing" },
        { sandboxBypassed: false },
      ) as ScriptInvocationId;

      const stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("work on thing");
      stream.respond({
        stopReason: "tool_use",
        text: "done",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-1" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: { ok: true },
            },
          },
        ],
      });

      await pollUntil(
        () => scriptManager.invocations.get(id)?.state.type === "done",
      );

      await driver.magenta.command("threads-overview");

      await driver.assertDisplayBufferContains("# SCRIPTS");
      await driver.assertDisplayBufferContains("foo");

      const inv = scriptManager.invocations.get(id);
      if (!inv) throw new Error("missing invocation");

      // The script row starts collapsed, hiding the whole invocation body
      // (parameters, logs, spawned threads). Expanding reveals them.
      await driver.assertDisplayBufferDoesNotContain("starting");

      await driver.triggerDisplayBufferKeyOnContent("foo (done)", "=");
      await driver.assertDisplayBufferContains("starting");
      await driver.assertDisplayBufferContains(`parameters: {"x":"thing"}`);
      await driver.assertDisplayBufferContains("yielded");
    },
  );
});

it("toggles sandbox bypass for the whole invocation from the script root row", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, FOO_SCRIPT);
      },
    },
    async (driver) => {
      await driver.showSidebar();
      const scriptManager = driver.magenta.scripts;
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

      const id = scriptManager.startScript(
        "foo",
        { x: "thing" },
        { sandboxBypassed: false },
      ) as ScriptInvocationId;

      const stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("work on thing");
      stream.respond({
        stopReason: "tool_use",
        text: "done",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-1" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: { ok: true },
            },
          },
        ],
      });

      await pollUntil(
        () => scriptManager.invocations.get(id)?.state.type === "done",
      );

      const inv = scriptManager.invocations.get(id);
      if (!inv) throw new Error("missing invocation");
      const threadId = inv.threadIds[0];
      expect(driver.magenta.chat.isSandboxBypassed(threadId)).toBe(false);

      await driver.magenta.command("threads-overview");
      await driver.assertDisplayBufferContains("foo (done)");
      // toggling with `t` flips the invocation sandbox flag.
      await driver.triggerDisplayBufferKeyOnContent("foo (done)", "t");

      await pollUntil(() => inv.sandboxBypassed === true);
      expect(driver.magenta.chat.isSandboxBypassed(threadId)).toBe(true);
      await driver.assertDisplayBufferContains("SANDBOX OFF");
    },
  );
});

it("expands and collapses the script row to show/hide spawned threads", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, FOO_SCRIPT);
      },
    },
    async (driver) => {
      await driver.showSidebar();
      const scriptManager = driver.magenta.scripts;
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

      const id = scriptManager.startScript(
        "foo",
        { x: "thing" },
        { sandboxBypassed: false },
      ) as ScriptInvocationId;

      const stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("work on thing");
      stream.respond({
        stopReason: "tool_use",
        text: "done",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-1" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: { ok: true },
            },
          },
        ],
      });

      await pollUntil(
        () => scriptManager.invocations.get(id)?.state.type === "done",
      );

      await driver.magenta.command("threads-overview");
      await driver.assertDisplayBufferContains("foo (done)");
      await driver.assertDisplayBufferDoesNotContain("yielded");

      await driver.triggerDisplayBufferKeyOnContent("foo (done)", "=");
      await driver.assertDisplayBufferContains("yielded");

      await driver.triggerDisplayBufferKeyOnContent("foo (done)", "=");
      await driver.assertDisplayBufferDoesNotContain("yielded");
    },
  );
});

it("surfaces a spawned thread's pending permission under a collapsed script row and approves it", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, FOO_SCRIPT);
      },
    },
    async (driver) => {
      driver.mockSandbox.setState({
        status: "unsupported",
        reason: "disabled",
      });
      await driver.showSidebar();
      const scriptManager = driver.magenta.scripts;
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

      const id = scriptManager.startScript(
        "foo",
        { x: "thing" },
        { sandboxBypassed: false },
      ) as ScriptInvocationId;

      const stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("work on thing");
      // The spawned thread runs a command, which blocks on approval because the
      // sandbox is disabled and the invocation is not bypassed.
      stream.respond({
        stopReason: "tool_use",
        text: "running",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "bash-tool" as ToolRequestId,
              toolName: "bash_command" as ToolName,
              input: { command: "echo hi" },
            },
          },
        ],
      });

      await pollUntil(
        () => (scriptManager.invocations.get(id)?.threadIds.length ?? 0) > 0,
      );
      const inv = scriptManager.invocations.get(id);
      if (!inv) throw new Error("missing invocation");
      const threadId = inv.threadIds[0];

      await driver.magenta.command("threads-overview");

      // The script row is collapsed, but the pending permission must still
      // surface so the user is never blocked invisibly.
      await driver.assertDisplayBufferContains("foo (running)");
      await driver.assertDisplayBufferContains("May I run command");

      const thread = driver.magenta.chat.threadWrappers[threadId];
      if (thread?.state !== "initialized")
        throw new Error("thread not initialized");
      expect(
        thread.thread.sandboxViolationHandler!.getPendingViolations().size,
      ).toBe(1);

      await driver.triggerDisplayBufferKeyOnContent("> YES", "<CR>");

      await pollUntil(
        () =>
          thread.thread.sandboxViolationHandler!.getPendingViolations().size ===
          0,
      );
    },
  );
});

it("toggling the invocation sandbox approves a spawned thread's pending permission", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, FOO_SCRIPT);
      },
    },
    async (driver) => {
      driver.mockSandbox.setState({
        status: "unsupported",
        reason: "disabled",
      });
      await driver.showSidebar();
      const scriptManager = driver.magenta.scripts;
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

      const id = scriptManager.startScript(
        "foo",
        { x: "thing" },
        { sandboxBypassed: false },
      );

      const stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("work on thing");
      stream.respond({
        stopReason: "tool_use",
        text: "running",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "bash-tool" as ToolRequestId,
              toolName: "bash_command" as ToolName,
              input: { command: "echo hi" },
            },
          },
        ],
      });

      await pollUntil(
        () => (scriptManager.invocations.get(id)?.threadIds.length ?? 0) > 0,
      );
      const inv = scriptManager.invocations.get(id);
      if (!inv) throw new Error("missing invocation");
      const threadId = inv.threadIds[0];
      const thread = driver.magenta.chat.threadWrappers[threadId];
      if (thread?.state !== "initialized")
        throw new Error("thread not initialized");

      await driver.magenta.command("threads-overview");
      await driver.assertDisplayBufferContains("foo (running)");
      await pollUntil(
        () =>
          thread.thread.sandboxViolationHandler!.getPendingViolations().size ===
          1,
      );

      // Bypassing the invocation must release every pending violation in its
      // thread subtree, not just future ones.
      await driver.triggerDisplayBufferKeyOnContent("foo (running)", "t");
      await pollUntil(
        () =>
          thread.thread.sandboxViolationHandler!.getPendingViolations().size ===
          0,
      );
      expect(driver.magenta.chat.isSandboxBypassed(threadId)).toBe(true);
      await driver.assertDisplayBufferContains("SANDBOX OFF");
    },
  );
});

it("owner shutdown disposes the scripts and the session", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, LONG_LIVED_SCRIPT);
      },
    },
    async (driver) => {
      const { scripts, session } = driver.magenta;
      await pollUntil(() => scripts.getCatalog().some((s) => s.name === "foo"));
      const id = scripts.startScript("foo", {}, { sandboxBypassed: false });
      await pollUntil(() =>
        (scripts.invocations.get(id)?.logs ?? []).some((l) =>
          l.startsWith("child "),
        ),
      );
      const childPid = scripts.childPid(id);
      expect(session.listThreads().length).toBeGreaterThan(0);
      driver.magenta.destroy();
      const childDead = () => {
        if (childPid === undefined) return true;
        try {
          process.kill(childPid, 0);
          return false;
        } catch {
          return true;
        }
      };
      await pollUntil(() => session.listThreads().length === 0 && childDead());
      await expect(session.createRootThread()).rejects.toThrow("disposed");
    },
  );
});
it("a failing script disposal still disposes the session", async () => {
  await withDriver({}, async (driver) => {
    const { scripts, session } = driver.magenta;
    const realDispose = scripts.dispose.bind(scripts);
    scripts.dispose = async () => {
      await realDispose();
      throw new Error("script teardown blew up");
    };
    expect(session.listThreads().length).toBeGreaterThan(0);
    driver.magenta.destroy();
    await pollUntil(() => session.listThreads().length === 0);
    await expect(session.createRootThread()).rejects.toThrow("disposed");
  });
});
