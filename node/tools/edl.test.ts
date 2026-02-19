import { test, expect, describe } from "vitest";
import { withDriver, assertToolResultContainsText } from "../test/preamble.ts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolRequestId, ToolName } from "./types.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { MockProvider } from "../providers/mock.ts";
import type { AbsFilePath } from "../utils/files.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import type { Line } from "../nvim/buffer.ts";
import { getAllBuffers } from "../nvim/nvim.ts";

type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;

describe("edl tool", () => {
  test("can execute a successful script", async () => {
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

        await driver.assertDisplayBufferContains(
          "📝✅ edl: 1 mutations in 1 file",
        );

        const resultStream = await driver.mockAnthropic.awaitPendingStream();
        const toolResultMessage = MockProvider.findLastToolResultMessage(
          resultStream.messages,
        );
        expect(toolResultMessage).toBeDefined();

        const content = toolResultMessage!.content as ContentBlockParam[];
        const toolResult = content.find(
          (c): c is ToolResultBlockParam => c.type === "tool_result",
        );
        expect(toolResult).toBeDefined();
        expect(toolResult!.is_error).toBeFalsy();
        assertToolResultContainsText(toolResult!, "Mutations:");

        const fileContent = await fs.readFile(filePath, "utf-8");
        expect(fileContent).toBe("goodbye world\n");
      },
    );
  });

  test("returns error on parse error", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("run edl script");
      await driver.send();

      const script = `file \`test.txt\`
invalid_command`;

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

      await driver.assertDisplayBufferContains("📝❌ edl script");

      const resultStream = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        resultStream.messages,
      );
      expect(toolResultMessage).toBeDefined();

      const content = toolResultMessage!.content as ContentBlockParam[];
      const toolResult = content.find(
        (c): c is ToolResultBlockParam => c.type === "tool_result",
      );
      expect(toolResult).toBeDefined();
      expect(toolResult!.is_error).toBe(true);
      expect(toolResult!.content).toContain("Parse error");
    });
  });

  test("returns error on execution error", async () => {
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
narrow /nonexistent pattern that does not exist/`;

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

        await driver.assertDisplayBufferContains(
          "📝✅ edl: 0 mutations in 0 files (1 file error)",
        );

        const resultStream = await driver.mockAnthropic.awaitPendingStream();
        const toolResultMessage = MockProvider.findLastToolResultMessage(
          resultStream.messages,
        );
        expect(toolResultMessage).toBeDefined();

        const content = toolResultMessage!.content as ContentBlockParam[];
        const toolResult = content.find(
          (c): c is ToolResultBlockParam => c.type === "tool_result",
        );
        expect(toolResult).toBeDefined();
        expect(toolResult!.is_error).toBeFalsy();
        assertToolResultContainsText(toolResult!, "File errors:");
      },
    );
  });

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

        // Summary should show mutation count
        await driver.assertDisplayBufferContains(
          "📝✅ edl: 1 mutations in 1 file",
        );

        // Preview should show per-file stats
        await driver.assertDisplayBufferContains("1 replace");
        await driver.assertDisplayBufferContains("Final selection: 1 range");
      },
    );
  });

  test("toggles between preview and detail view", async () => {
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

        await driver.assertDisplayBufferContains("📝✅ edl:");

        // Toggle to detail view
        const previewPos =
          await driver.assertDisplayBufferContains("1 replace");
        await driver.triggerDisplayBufferKey(previewPos, "<CR>");

        // Detail should show full trace output
        await driver.assertDisplayBufferContains("Trace:");
        await driver.assertDisplayBufferContains("Mutations:");
      },
    );
  });

  test("preview shows abridged script for long scripts", async () => {
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
        const longLine = "a".repeat(100);
        const extraLines = Array.from(
          { length: 12 },
          (_, i) => `# comment line ${i} ${longLine}`,
        ).join("\n");
        const script = `file \`${filePath}\`
${extraLines}
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

        await driver.assertDisplayBufferContains("📝✅ edl:");

        // Preview should show truncated lines (ending with ...)
        await driver.assertDisplayBufferContains("aaa...");

        // Preview should show the "more lines" indicator
        await driver.assertDisplayBufferContains("more lines)");

        // Preview should NOT show the full long line
        await driver.assertDisplayBufferDoesNotContain(longLine);
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

        await driver.assertDisplayBufferContains("📝✅ edl:");

        // Preview should show the script
        await driver.assertDisplayBufferContains("narrow /hello/");

        // Toggle to detail view
        const pos = await driver.assertDisplayBufferContains("narrow /hello/");
        await driver.triggerDisplayBufferKey(pos, "<CR>");

        // Detail should show full script AND the trace output
        await driver.assertDisplayBufferContains("narrow /hello/");
        await driver.assertDisplayBufferContains("replace <<END");
        await driver.assertDisplayBufferContains("Trace:");
        await driver.assertDisplayBufferContains("Mutations:");
      },
    );
  });
});

describe("edl tool buffer integration", () => {
  test("edl edit updates context manager agent view", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(path.join(tmpDir, "test.txt"), "hello world\n");
        },
      },
      async (driver, dirs) => {
        await driver.showSidebar();
        await driver.addContextFiles("test.txt");

        const absFilePath = path.resolve(
          dirs.tmpDir,
          "test.txt",
        ) as AbsFilePath;
        const contextManager =
          driver.magenta.chat.getActiveThread().contextManager;

        await driver.inputMagentaText("edit the file");
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
          text: "I'll edit the file",
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

        await driver.assertDisplayBufferContains(
          "📝✅ edl: 1 mutations in 1 file",
        );

        const fileInfo = contextManager.files[absFilePath];
        expect(fileInfo).toBeDefined();
        expect(fileInfo.agentView).toEqual({
          type: "text",
          content: "goodbye world\n",
        });
      },
    );
  });

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
replace <<END
goodbye
END`;

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

        await driver.assertDisplayBufferContains("📝✅ edl:");

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

  test("edl reads from buffer when buffer has unsaved changes", async () => {
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

        // Step 1: Run EDL to write to the file (this tracks the buffer in bufferTracker)
        await driver.inputMagentaText("edit file");
        await driver.send();

        const script1 = `file \`${filePath}\`
narrow /original/
replace <<END
modified
END`;

        const stream1 = await driver.mockAnthropic.awaitPendingStream();
        stream1.respond({
          stopReason: "tool_use",
          text: "editing",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "edl" as ToolName,
                input: { script: script1 },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains(
          "📝✅ edl: 1 mutations in 1 file",
        );

        // End first turn
        const autoStream = await driver.mockAnthropic.awaitPendingStream();
        autoStream.respond({
          stopReason: "end_turn",
          text: "Done!",
          toolRequests: [],
        });
        await driver.mockAnthropic.awaitStopped();

        // Step 2: Edit buffer without saving (simulating user edit)
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

        // Disk still has old content
        const diskContent = await fs.readFile(filePath, "utf-8");
        expect(diskContent).toBe("modified content\n");

        // Step 3: Run EDL that searches for content only present in the buffer
        await driver.inputMagentaText("edit again");
        await driver.send();

        const script2 = `file \`${filePath}\`
narrow /buffer only/
replace <<END
replaced
END`;

        const stream2 = await driver.mockAnthropic.awaitPendingStream();
        stream2.respond({
          stopReason: "tool_use",
          text: "editing again",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_2" as ToolRequestId,
                toolName: "edl" as ToolName,
                input: { script: script2 },
              },
            },
          ],
        });

        // If EDL succeeds, it read "buffer only" from the buffer (not disk which has "modified")
        await driver.assertDisplayBufferContains(
          "📝✅ edl: 1 mutations in 1 file",
        );
      },
    );
  });
});
