import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/server";
import { expect, test } from "vitest";
import type { Row0Indexed } from "../nvim/window.ts";
import { withDriver } from "../test/preamble.ts";

test("summary shows edited file, opens on <CR>, and persists on next turn", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await fs.writeFile(path.join(tmpDir, "a.txt"), "hello\n");
        await fs.writeFile(path.join(tmpDir, "b.txt"), "world\n");
      },
    },
    async (driver, dirs) => {
      await driver.showSidebar();
      await driver.inputMagentaText("edit a");
      await driver.send();

      const aPath = path.join(dirs.tmpDir, "a.txt");
      const bPath = path.join(dirs.tmpDir, "b.txt");

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "tool_use",
        text: "editing a",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "t1" as ToolRequestId,
              toolName: "edl" as ToolName,
              input: {
                script: `file \`${aPath}\`\nnarrow /hello/\nreplace "bye"`,
              },
            },
          },
        ],
      });

      const followup1 = await driver.mockAnthropic.awaitPendingStream();
      followup1.respond({
        stopReason: "end_turn",
        text: "done",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContains("Files edited:");

      // `=` expands the recorded before/after diff.
      await driver.triggerDisplayBufferKeyOnContent("▶ modified a.txt", "=");
      await driver.assertDisplayBufferContains("-hello");
      await driver.assertDisplayBufferContains("+bye");

      // `=` again collapses it.
      await driver.triggerDisplayBufferKeyOnContent("▼ modified a.txt", "=");
      await driver.assertDisplayBufferDoesNotContain("+bye");

      // `<CR>` opens the before-vs-after diffsplit.
      await driver.triggerDisplayBufferKeyOnContent("▶ modified a.txt", "<CR>");

      // The scratch snapshot buffer opens alongside the recorded after-content, both in diff
      // mode, and the scratch buffer holds the pre-edit snapshot content.
      const snapshotWindow = await driver.findWindow(async (w) => {
        const name = await (await w.buffer()).getName();
        return name.endsWith("_snapshot");
      });
      const snapshotLines = await (await snapshotWindow.buffer()).getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      expect(snapshotLines).toContain("hello");
      expect(await snapshotWindow.getOption("diff")).toBe(true);

      const fileWindow = await driver.findWindow(async (w) => {
        const name = await (await w.buffer()).getName();
        return name.endsWith("a.txt_after");
      });
      expect(await fileWindow.getOption("diff")).toBe(true);

      // The magenta sidebar windows are preserved through the diffsplit.
      const magentaWindows = await driver.findWindow(
        async (w) => (await w.getVar("magenta")) === true,
      );
      expect(magentaWindows).toBeDefined();

      await driver.inputMagentaText("edit b");
      await driver.send();

      await driver.assertDisplayBufferContains("Files edited:");

      const stream2 = await driver.mockAnthropic.awaitPendingStream();
      stream2.respond({
        stopReason: "tool_use",
        text: "editing b",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "t2" as ToolRequestId,
              toolName: "edl" as ToolName,
              input: {
                script: `file \`${bPath}\`\nnarrow /world/\nreplace "globe"`,
              },
            },
          },
        ],
      });

      const followup2 = await driver.mockAnthropic.awaitPendingStream();
      followup2.respond({
        stopReason: "end_turn",
        text: "done",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContains("Files edited:");
      await driver.assertDisplayBufferContains("b.txt");
      await driver.assertDisplayBufferContains("▶ modified a.txt");
      await driver.triggerDisplayBufferKeyOnContent("▶ modified a.txt", "=");
      await driver.assertDisplayBufferContains("+bye");
    },
  );
});

test("created file shows 'created' and opens directly on <CR>", async () => {
  await withDriver({}, async (driver, dirs) => {
    await driver.showSidebar();
    await driver.inputMagentaText("create c");
    await driver.send();

    const cPath = path.join(dirs.tmpDir, "c.txt");

    const stream = await driver.mockAnthropic.awaitPendingStream();
    stream.respond({
      stopReason: "tool_use",
      text: "creating c",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "t1" as ToolRequestId,
            toolName: "edl" as ToolName,
            input: {
              script: `newfile \`${cPath}\`\ninsert_after "fresh"`,
            },
          },
        },
      ],
    });

    const followup = await driver.mockAnthropic.awaitPendingStream();
    followup.respond({
      stopReason: "end_turn",
      text: "done",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("Files edited:");
    await driver.assertDisplayBufferContains("▶ created c.txt");

    // `<CR>` opens the file directly (no snapshot diff buffer).
    await driver.triggerDisplayBufferKeyOnContent("▶ created c.txt", "<CR>");

    const fileWindow = await driver.findWindow(async (w) => {
      const name = await (await w.buffer()).getName();
      return name.endsWith("c.txt");
    });
    expect(await fileWindow.getOption("diff")).toBe(false);
  });
});

test("historical diff ignores later unsaved buffer changes", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await fs.writeFile(path.join(tmpDir, "a.txt"), "hello\n");
      },
    },
    async (driver, dirs) => {
      await driver.showSidebar();
      await driver.inputMagentaText("edit a");
      await driver.send();

      const aPath = path.join(dirs.tmpDir, "a.txt");

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "tool_use",
        text: "editing a",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "t1" as ToolRequestId,
              toolName: "edl" as ToolName,
              input: {
                script: `file \`${aPath}\`\nnarrow /hello/\nreplace "bye"`,
              },
            },
          },
        ],
      });

      const followup = await driver.mockAnthropic.awaitPendingStream();
      followup.respond({
        stopReason: "end_turn",
        text: "done",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContains("Files edited:");

      // Open the file in a (non-magenta) buffer and give it unsaved content
      // that differs from both the snapshot and what's on disk.
      await driver.nvim.call("nvim_command", [
        `botright split | edit ${aPath}`,
      ]);
      const buf = await driver.nvim.call("nvim_get_current_buf", []);
      await driver.nvim.call("nvim_buf_set_lines", [
        buf,
        0,
        -1,
        false,
        ["buffered"],
      ]);

      // Historical diffs retain the recorded edit rather than later buffer changes.
      await driver.triggerDisplayBufferKeyOnContent("▶ modified a.txt", "=");
      await driver.assertDisplayBufferContains("-hello");
      await driver.assertDisplayBufferContains("+bye");
      await driver.assertDisplayBufferDoesNotContain("+buffered");
    },
  );
});
