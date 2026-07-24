import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/core";
import { expect, test } from "vitest";
import type { Row0Indexed } from "../nvim/window.ts";
import { withDriver } from "../test/preamble.ts";

test("summary shows edited file, opens on <CR>, and resets on next turn", async () => {
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

      await driver.assertDisplayBufferContains("Files edited this turn:");

      // `=` expands an inline unified diff of the snapshot vs current content.
      await driver.triggerDisplayBufferKeyOnContent("▶ modified a.txt", "=");
      await driver.assertDisplayBufferContains("-hello");
      await driver.assertDisplayBufferContains("+bye");

      // `=` again collapses it.
      await driver.triggerDisplayBufferKeyOnContent("▼ modified a.txt", "=");
      await driver.assertDisplayBufferDoesNotContain("+bye");

      // `<CR>` opens the snapshot-vs-live diffsplit.
      await driver.triggerDisplayBufferKeyOnContent("▶ modified a.txt", "<CR>");

      // The scratch snapshot buffer opens alongside the live file, both in diff
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
        return name.endsWith("a.txt");
      });
      expect(await fileWindow.getOption("diff")).toBe(true);

      // The magenta sidebar windows are preserved through the diffsplit.
      const magentaWindows = await driver.findWindow(
        async (w) => (await w.getVar("magenta")) === true,
      );
      expect(magentaWindows).toBeDefined();

      await driver.inputMagentaText("edit b");
      await driver.send();

      await driver.assertDisplayBufferDoesNotContain("Files edited this turn:");

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

      await driver.assertDisplayBufferContains("Files edited this turn:");
      await driver.assertDisplayBufferContains("b.txt");
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

    await driver.assertDisplayBufferContains("Files edited this turn:");
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

test("expand diff reads current content from an open buffer, not disk", async () => {
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

      await driver.assertDisplayBufferContains("Files edited this turn:");

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

      // The inline diff must reflect the live buffer content, not the on-disk
      // ("bye") content.
      await driver.triggerDisplayBufferKeyOnContent("▶ modified a.txt", "=");
      await driver.assertDisplayBufferContains("-hello");
      await driver.assertDisplayBufferContains("+buffered");
    },
  );
});
