import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/server";
import { describe, expect, test } from "vitest";
import type { Line } from "../nvim/buffer.ts";
import { getAllBuffers, getAllWindows } from "../nvim/nvim.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

describe("edl tool", () => {
  test("shows mutation summary in display", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(path.join(tmpDir, "test.txt"), "hello world\n");
        },
      },
      async (driver, dirs) => {
        await driver.showSidebar();
        await driver.inputMagentaText("run edl script");
        await driver.send();

        const filePath = path.join(dirs.tmpDir, "test.txt");
        const script = `file \`${filePath}\`
narrow /hello/
replace "goodbye"`;

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll run an EDL script",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "edl" as ToolName,
                input: { script },
              },
            },
          ],
        });

        // Summary should show mutation count
        await driver.assertDisplayBufferContains(
          "✅ edl: 1 mutations in 1 file",
        );

        // Preview should show per-file stats
        await driver.assertDisplayBufferContains("1 replace");
        await driver.assertDisplayBufferContains("Final selection: 1 range");
      },
    );
  });

  test("= expands the result into an edl trace (not the script)", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(path.join(tmpDir, "test.txt"), "hello world\n");
        },
      },
      async (driver, dirs) => {
        await driver.showSidebar();
        await driver.inputMagentaText("run edl script");
        await driver.send();

        const filePath = path.join(dirs.tmpDir, "test.txt");
        const script = `file \`${filePath}\`
# UNIQUE_SEGMENT_MARKER
narrow /hello/
replace "goodbye"`;

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll run an EDL script",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "edl" as ToolName,
                input: { script },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains("✅ edl:");

        // The raw script is not shown in the result rows
        await driver.assertDisplayBufferDoesNotContain("UNIQUE_SEGMENT_MARKER");

        // Expanding the result shows a trace, not the script
        await driver.triggerDisplayBufferKeyOnContent("1 replace", "=");
        await driver.assertDisplayBufferContains("Trace:");
        await driver.assertDisplayBufferDoesNotContain("UNIQUE_SEGMENT_MARKER");

        // Collapse again
        await driver.triggerDisplayBufferKeyOnContent("Trace:", "=");
        await driver.assertDisplayBufferContains("1 replace");
      },
    );
  });

  test("= on the result summary line pretty-prints the trace (not JSON)", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(path.join(tmpDir, "test.txt"), "hello world\n");
        },
      },
      async (driver, dirs) => {
        await driver.showSidebar();
        await driver.inputMagentaText("run edl script");
        await driver.send();

        const filePath = path.join(dirs.tmpDir, "test.txt");
        const script = `file \`${filePath}\`
narrow /hello/
replace "goodbye"`;

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll run an EDL script",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "edl" as ToolName,
                input: { script },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains("✅ edl:");

        // Expanding the result summary shows the formatted trace, not a raw
        // JSON.stringify of the tool result value.
        await driver.triggerDisplayBufferKeyOnContent("✅ edl:", "=");
        await driver.assertDisplayBufferContains("Trace:");
        await driver.assertDisplayBufferContains("Mutations:");
        await driver.assertDisplayBufferDoesNotContain('"type": "text"');

        // Collapse again
        await driver.triggerDisplayBufferKeyOnContent("✅ edl:", "=");
        await driver.assertDisplayBufferDoesNotContain("Mutations:");
      },
    );
  });

  test("<CR> navigates to the edited file", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(path.join(tmpDir, "test.txt"), "hello world\n");
        },
      },
      async (driver, dirs) => {
        await driver.showSidebar();
        await driver.inputMagentaText("run edl script");
        await driver.send();

        const filePath = path.join(dirs.tmpDir, "test.txt");
        const script = `file \`${filePath}\`
narrow /hello/
replace "goodbye"`;

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll run an EDL script",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "edl" as ToolName,
                input: { script },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains("✅ edl:");
        await driver.triggerDisplayBufferKeyOnContent("1 replace", "<CR>");

        const targetBufferName = await pollUntil(
          async () => {
            const windows = await getAllWindows(driver.nvim);
            for (const w of windows) {
              const isMagenta = await w.getVar("magenta");
              if (isMagenta) continue;
              const buf = await w.buffer();
              const name = await buf.getName();
              if (/test\.txt$/.test(name)) {
                return name;
              }
            }
            throw new Error("test.txt not yet opened in non-magenta window");
          },
          { timeout: 2000 },
        );
        expect(targetBufferName).toMatch(/test\.txt$/);
      },
    );
  });

  test("hides the script preview once the tool completes", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(path.join(tmpDir, "test.txt"), "hello world\n");
        },
      },
      async (driver, dirs) => {
        await driver.showSidebar();
        await driver.inputMagentaText("run edl script");
        await driver.send();

        const filePath = path.join(dirs.tmpDir, "test.txt");
        const script = `file \`${filePath}\`
# PREVIEW_ONLY_MARKER
narrow /hello/
replace "goodbye"`;

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll run an EDL script",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "edl" as ToolName,
                input: { script },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains("✅ edl:");

        // Once completed, the streaming script preview is hidden
        await driver.assertDisplayBufferDoesNotContain("PREVIEW_ONLY_MARKER");
      },
    );
  });

  test("detail view shows full unabridged script", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(path.join(tmpDir, "test.txt"), "hello world\n");
        },
      },
      async (driver, dirs) => {
        await driver.showSidebar();
        await driver.inputMagentaText("run edl script");
        await driver.send();

        const filePath = path.join(dirs.tmpDir, "test.txt");
        const script = `file \`${filePath}\`
narrow /hello/
replace <<END
goodbye
END`;

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll run an EDL script",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "edl" as ToolName,
                input: { script },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains("✅ edl:");

        // After completion the preview is hidden
        await driver.assertDisplayBufferDoesNotContain("narrow /hello/");

        // Expanding the request summary shows the raw input (full script)
        await driver.triggerDisplayBufferKeyOnContent("📝 edl script", "=");
        await driver.assertDisplayBufferContains("narrow /hello/");
        await driver.assertDisplayBufferContains("replace <<END");
        // The script is shown verbatim, not as a JSON.stringify of the input
        await driver.assertDisplayBufferDoesNotContain('"script":');
      },
    );
  });
});

describe("edl tool buffer integration", () => {
  test("edl writes to nvim buffer when file is open", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(path.join(tmpDir, "test.txt"), "hello world\n");
        },
      },
      async (driver, dirs) => {
        await driver.editFile("test.txt");
        await driver.showSidebar();

        const filePath = path.join(dirs.tmpDir, "test.txt");

        await driver.inputMagentaText("edit the file");
        await driver.send();

        const script = `file \`${filePath}\`
narrow /hello/
replace "goodbye"`;

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "editing",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "edl" as ToolName,
                input: { script },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains("✅ edl:");

        // Verify the nvim buffer was updated (not just disk)
        const buffers = await getAllBuffers(driver.nvim);
        let testBuffer;
        for (const buf of buffers) {
          const name = await buf.getName();
          if (name.includes("test.txt")) {
            testBuffer = buf;
            break;
          }
        }
        expect(testBuffer).toBeDefined();
        if (!testBuffer) throw new Error("testBuffer undefined");

        const lines = await testBuffer.getLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
        });
        expect(lines.join("\n")).toBe("goodbye world");

        // Verify disk was also saved (nvim adds trailing newline on save)
        const diskContent = await fs.readFile(filePath, "utf-8");
        expect(diskContent).toBe("goodbye world\n");
      },
    );
  });

  test("edl reads from disk even when buffer has unsaved changes", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(
            path.join(tmpDir, "test.txt"),
            "original content\n",
          );
        },
      },
      async (driver, dirs) => {
        await driver.editFile("test.txt");
        await driver.showSidebar();

        const filePath = path.join(dirs.tmpDir, "test.txt");

        // Modify buffer without saving so buffer and disk differ
        const buffers = await getAllBuffers(driver.nvim);
        let testBuffer;
        for (const buf of buffers) {
          const name = await buf.getName();
          if (name.includes("test.txt")) {
            testBuffer = buf;
            break;
          }
        }
        expect(testBuffer).toBeDefined();
        if (!testBuffer) throw new Error("expected testBuffer to be defined");

        await testBuffer.setLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
          lines: ["buffer only content" as Line],
        });

        // Disk still has original content
        const diskContent = await fs.readFile(filePath, "utf-8");
        expect(diskContent).toBe("original content\n");

        // Run EDL that searches for content on disk (not in buffer)
        await driver.inputMagentaText("edit the file");
        await driver.send();

        const script = `file \`${filePath}\`
narrow /original/
replace "disk-based"`;

        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "editing",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "edl" as ToolName,
                input: { script },
              },
            },
          ],
        });

        // EDL should succeed because it reads from disk where "original" exists
        await driver.assertDisplayBufferContains(
          "✅ edl: 1 mutations in 1 file",
        );

        // Verify disk was updated
        const updatedDisk = await fs.readFile(filePath, "utf-8");
        expect(updatedDisk).toBe("disk-based content\n");
      },
    );
  });
});
