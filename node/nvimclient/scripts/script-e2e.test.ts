import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/server";
import { expect, it } from "vitest";
import { notificationLog, resetNotificationLog } from "../chat/notify.ts";
import { BUILTIN_SDK_PATH } from "../options.ts";
import { withDriver } from "../test/preamble.ts";

async function setupScript(tmpDir: string, body: string): Promise<void> {
  const pkgDir = path.join(tmpDir, ".magenta", "scripts", "pkg");
  await fs.mkdir(pkgDir, { recursive: true });
  await fs.writeFile(path.join(pkgDir, "index.ts"), body);
  await fs.symlink(BUILTIN_SDK_PATH, path.join(pkgDir, "magenta-sdk"));
}

async function pollUntil(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 10000,
): Promise<void> {
  const start = Date.now();
  while (!(await fn())) {
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

it("end-to-end: agent invokes run_script, subprocess spawns a thread, yields, and the UI reflects it", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, FOO_SCRIPT);
      },
    },
    async (driver) => {
      await driver.showSidebar();
      const scriptManager = driver.magenta.scriptManager;

      // 1. Script is detected and registered in the catalog.
      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "foo"),
      );

      // 2. The in-magenta agent invokes the script via run_script.
      await driver.inputMagentaText("please run foo");
      driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "running the script",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "run-1" as ToolRequestId,
              toolName: "run_script" as ToolName,
              input: { scriptName: "foo", parameters: { x: "thing" } },
            },
          },
        ],
      });

      // 3. The subprocess runs and its thread() spawns a real thread that hits
      //    the mock provider.
      await pollUntil(() => scriptManager.invocations.size > 0);
      const inv = [...scriptManager.invocations.values()][0];

      const stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("work on thing");

      // 4. The spawned thread yields a schema-matching structured result.
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

      // 5. The runner completes.
      await pollUntil(() => inv.status === "done");
      expect(inv.scriptName).toBe("foo");
      expect(inv.threadIds.length).toBe(1);
      expect(inv.logs).toContain("starting");
      expect(inv.logs.some((l) => l.includes('"ok":true'))).toBe(true);

      // 6. The Scripts section reflects the invocation and its log line.
      await driver.magenta.command("threads-overview");
      await driver.assertDisplayBufferContains("# SCRIPTS");
      await driver.assertDisplayBufferContains("foo (done)");

      // 7. The row starts collapsed (whole invocation body hidden); expanding
      // reveals the log line and a link to the spawned thread, but the yield
      // result stays hidden until the thread line itself is expanded.
      await driver.assertDisplayBufferDoesNotContain("starting");
      await driver.assertDisplayBufferDoesNotContain("yielded");
      await driver.triggerDisplayBufferKeyOnContent("foo (done)", "=");
      await driver.assertDisplayBufferContains("starting");
      await driver.assertDisplayBufferDoesNotContain("⮑ yielded:");

      // 8. Expanding the spawned thread line reveals its yield result.
      await driver.triggerDisplayBufferKeyOnContent("work on thing", "=");
      await driver.assertDisplayBufferContains("⮑ yielded:");
    },
  );
});

const TWO_THREAD_SCRIPT = `
import { registerScript } from "./magenta-sdk/index.ts";

const yieldSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
};

registerScript(
  "twothreads",
  "spawns two threads",
  { type: "object", properties: {}, additionalProperties: false },
  async (_params, thread, log) => {
    log("starting");
    await thread("work on one", yieldSchema);
    await thread("work on two", yieldSchema);
    log("finished");
  },
);
`;

function countBells(text: string): number {
  return (text.match(/🔔/g) ?? []).length;
}

it("bell behavior: pending-approval bells propagate to script+neovim, yields don't, completion bells", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await setupScript(tmpDir, TWO_THREAD_SCRIPT);
      },
    },
    async (driver) => {
      // Make any sandbox-checked command require an approval prompt.
      driver.mockSandbox.setState({
        status: "unsupported",
        reason: "disabled",
      });
      await driver.showSidebar();
      const scriptManager = driver.magenta.scriptManager;

      await pollUntil(() =>
        scriptManager.getCatalog().some((s) => s.name === "twothreads"),
      );

      // Main agent launches the script.
      await driver.inputMagentaText("please run twothreads");
      driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "running the script",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "run-1" as ToolRequestId,
              toolName: "run_script" as ToolName,
              input: { scriptName: "twothreads", parameters: {} },
            },
          },
        ],
      });

      await pollUntil(() => scriptManager.invocations.size > 0);
      const inv = [...scriptManager.invocations.values()][0];

      // Thread 1 starts and asks to run a command that needs approval.
      const t1 =
        await driver.mockAnthropic.awaitPendingStreamWithText("work on one");

      // View the overview so the active main thread is marked viewed and won't
      // contribute its own bell to the assertions below.
      await driver.magenta.command("threads-overview");
      await driver.assertDisplayBufferContains("# SCRIPTS");

      resetNotificationLog();
      t1.respond({
        stopReason: "tool_use",
        text: "I'll run a command.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "bash-1" as ToolRequestId,
              toolName: "bash_command" as ToolName,
              input: { command: "mkdir bell-test-dir" },
            },
          },
        ],
      });

      // The approval surfaces, and neovim is notified that a thread wants
      // attention.
      await driver.assertDisplayBufferContains("May I run command");
      await pollUntil(() =>
        notificationLog.some((n) => n.reason === "thread-attention"),
      );

      // The bell is propagated to the script row. Expand the invocation so the
      // waiting thread's own row (and its bell) is visible too.
      await driver.triggerDisplayBufferKeyOnContent(
        "twothreads (running)",
        "=",
      );
      await driver.assertDisplayBufferContains("work on one");
      await pollUntil(async () => {
        const text = await driver.getDisplayBufferText();
        // One bell on the script row, one on the waiting thread row.
        return countBells(text) >= 2;
      });

      // Collapse the invocation again so the approval dialog (only shown on the
      // collapsed row) is visible, then approve and let thread 1 yield.
      await driver.triggerDisplayBufferKeyOnContent(
        "twothreads (running)",
        "=",
      );
      await driver.assertDisplayBufferContains("> YES");
      await driver.triggerDisplayBufferKeyOnContent("> YES", "<CR>");
      await driver.assertDisplayBufferDoesNotContain("> YES");

      const t1Resume = await driver.mockAnthropic.awaitPendingStream({
        predicate: (stream) =>
          stream.messages.some(
            (m) =>
              m.role === "user" &&
              Array.isArray(m.content) &&
              m.content.some(
                (b) => b.type === "tool_result" && b.tool_use_id === "bash-1",
              ),
          ),
        message: "waiting for thread 1 resume after approval",
      });

      resetNotificationLog();
      t1Resume.respond({
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

      // Thread 1 yields and thread 2 starts streaming. Yielding must not bell:
      // not the thread, not the script row, and not neovim.
      const t2 =
        await driver.mockAnthropic.awaitPendingStreamWithText("work on two");
      await driver.assertDisplayBufferDoesNotContain("🔔");
      expect(notificationLog).toEqual([]);

      // Thread 2 yields, which finishes the script.
      resetNotificationLog();
      t2.respond({
        stopReason: "tool_use",
        text: "done",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-2" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: { ok: true },
            },
          },
        ],
      });

      await pollUntil(() => inv.status === "done");

      // Finishing the script bells the script row and notifies neovim so the
      // user knows the run completed.
      await pollUntil(() =>
        notificationLog.some((n) => n.reason === "script-finished"),
      );
      await driver.assertDisplayBufferContains("🔔");
    },
  );
});
