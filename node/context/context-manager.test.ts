import { describe, expect, it } from "vitest";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";
import { getAllWindows, getcwd } from "../nvim/nvim.ts";
import {
  resolveFilePath,
  type UnresolvedFilePath,
  type HomeDir,
} from "../utils/files.ts";
import type { Line } from "../nvim/buffer.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import type { DiffUpdate, WholeFileUpdate } from "./context-manager.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import fs from "node:fs";
import * as os from "node:os";
import type { ToolName } from "../tools/types.ts";
import {
  type ProviderImageContent,
  type ProviderMessage,
  type ProviderMessageContent,
} from "../providers/provider-types.ts";

it("returns full file contents on first getContextUpdate and no updates on second call when file hasn't changed", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Get the context manager from the driver
    const contextManager =
      driver.magenta.chat.getActiveThread().context.contextManager;

    const cwd = await getcwd(driver.nvim);
    const absFilePath = resolveFilePath(
      cwd,
      "poem.txt" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    // Add file to context using the helper method
    await driver.addContextFiles("poem.txt");

    // Get context updates - first call
    const firstUpdates = await contextManager.getContextUpdate();

    // Check that the update contains the file
    expect(firstUpdates[absFilePath]).toBeDefined();

    // Check that it's a whole-file update
    const firstUpdate = firstUpdates[absFilePath];
    expect(firstUpdate.update.status).toBe("ok");

    // Type-safe narrowing for the update result
    const okResult = firstUpdate.update as Extract<
      typeof firstUpdate.update,
      { status: "ok" }
    >;
    expect(okResult.value.type).toBe("whole-file");
    expect(firstUpdate.absFilePath).toBe(absFilePath);

    // Extract the actual file content from the content array (second text block)
    const wholeFileUpdate = okResult.value as WholeFileUpdate;
    const textBlocks = wholeFileUpdate.content.filter(
      (item) => item.type === "text",
    );

    expect(textBlocks).toHaveLength(2);
    expect(textBlocks[0].text).toBe("File `poem.txt`");
    expect(textBlocks[1].text).toContain(
      "Moonlight whispers through the trees",
    );

    // Get context updates second time without changing the file
    const secondUpdates = await contextManager.getContextUpdate();

    // The second update should be empty if no changes were made
    expect(Object.keys(secondUpdates).length).toBe(0);
  });
});

it("returns diff when file is edited in a buffer", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Get the context manager from the driver
    const contextManager =
      driver.magenta.chat.getActiveThread().context.contextManager;

    const cwd = await getcwd(driver.nvim);
    const absFilePath = resolveFilePath(
      cwd,
      "poem.txt" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    // Add file to context using the helper method
    await driver.addContextFiles("poem.txt");

    // First, edit the file to track the buffer
    await driver.editFile("poem.txt");
    await contextManager.getContextUpdate();

    const window = await driver.findWindow(async (w) => {
      const buffer = await w.buffer();
      const bufName = await buffer.getName();
      return bufName.indexOf("poem.txt") > -1;
    });
    const buffer = await window.buffer();
    await buffer.setLines({
      start: 0 as Row0Indexed,
      end: 1 as Row0Indexed,
      lines: ["Edited moonlight dances through the trees," as Line],
    });

    // Get context updates after the edit
    const updates = await contextManager.getContextUpdate();
    const update = updates[absFilePath];
    // Check that it's a diff update
    expect(update).toBeDefined();
    expect(update.update.status).toBe("ok");
    if (update.update.status === "ok") {
      expect(update.update.value.type).toBe("diff");
      expect(update.absFilePath).toBe(absFilePath);
      // Check that the diff contains the change
      expect((update.update.value as DiffUpdate).patch).toContain(
        "Edited moonlight",
      );
      expect((update.update.value as DiffUpdate).patch).toContain(
        "Moonlight whispers",
      );
    }
  });
});

it("returns error when both buffer and disk change after agentView set", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    const contextManager =
      driver.magenta.chat.getActiveThread().context.contextManager;

    const cwd = await getcwd(driver.nvim);
    const absFilePath = resolveFilePath(
      cwd,
      "poem.txt" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    await driver.addContextFiles("poem.txt");
    await driver.editFile("poem.txt");

    // Initial read to establish agentView and buffer tracking
    await contextManager.getContextUpdate();

    // Edit the buffer (without saving)
    const window = await driver.findWindow(async (w) => {
      const buffer = await w.buffer();
      const bufName = await buffer.getName();
      return bufName.indexOf("poem.txt") > -1;
    });
    const buffer = await window.buffer();
    await buffer.setLines({
      start: 0 as Row0Indexed,
      end: 1 as Row0Indexed,
      lines: ["Buffer edit" as Line],
    });

    // Also modify the file on disk directly
    const filePath = `${cwd}/poem.txt`;
    fs.writeFileSync(filePath, "Disk edit\n");

    // Context update should return an error for this file
    const updates = await contextManager.getContextUpdate();
    const update = updates[absFilePath];
    expect(update).toBeDefined();
    expect(update.update.status).toBe("error");
    if (update.update.status === "error") {
      expect(update.update.error).toContain("Both");
    }
  });
});
it("returns diff when file is edited on disk", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Get the context manager from the driver
    const contextManager =
      driver.magenta.chat.getActiveThread().context.contextManager;

    const cwd = await getcwd(driver.nvim);
    const absFilePath = resolveFilePath(
      cwd,
      "poem.txt" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    // Add file to context using the helper method
    await driver.addContextFiles("poem.txt");

    // Get initial context update
    await contextManager.getContextUpdate();

    // Edit the file on disk
    const updatedContent =
      "Modified content directly on disk\nThis should be detected.";
    await fs.promises.writeFile(absFilePath, updatedContent);

    // Get context updates after the edit
    const updates = await contextManager.getContextUpdate();

    // Check that the update contains the file
    expect(updates[absFilePath]).toBeDefined();

    // Check that it reflects the changes from disk
    const update = updates[absFilePath];
    expect(
      update.update.status == "ok" &&
        update.update.value.type == "diff" &&
        update.update.value.patch,
    ).toContain("Modified content");

    // Restore the original file content for other tests
    const originalContent = `Moonlight whispers through the trees,
      Silver shadows dance with ease.
      Stars above like diamonds bright,
    Paint their stories in the night.
      `;
    await fs.promises.writeFile(absFilePath, originalContent);
  });
});

describe("key bindings", () => {
  it("'dd' key correctly removes the middle file when three files are in context", async () => {
    await withDriver({}, async (driver) => {
      // Open context sidebar
      await driver.showSidebar();

      await driver.addContextFiles("poem 3.txt", "poem2.txt", "poem.txt");

      const middleFilePos =
        await driver.assertDisplayBufferContains(`- \`poem2.txt\``);

      // Press dd on the middle file to remove it
      await driver.triggerDisplayBufferKey(middleFilePos, "dd");

      // Wait for the file to be removed from context
      await pollUntil(async () => {
        const content = await driver.getDisplayBufferText();
        if (content.includes(`- \`poem2.txt\``)) {
          throw new Error("Context file not yet removed");
        }
        if (
          !content.includes(`- \`poem 3.txt\``) ||
          !content.includes(`- \`poem.txt\``)
        ) {
          throw new Error("Other context files should still be present");
        }
      });
    });
  });

  it("'Enter' key opens file in existing non-magenta window", async () => {
    await withDriver({}, async (driver) => {
      const normalWindow = await driver.findWindow(async (w) => {
        const buf = await w.buffer();
        const name = await buf.getName();
        return name === "";
      });

      // Open context sidebar
      await driver.showSidebar();

      // Add file to context using the helper method
      await driver.addContextFiles("poem.txt");

      const pos = await driver.assertDisplayBufferContains(`\`poem.txt\``);

      await driver.triggerDisplayBufferKey(pos, "<CR>");

      await driver.assertWindowCount(
        3,
        "3 windows - display, input and non-magenta window with the buffer open",
      );

      // Verify file is opened in the non-magenta window
      await pollUntil(async () => {
        const winBuffer = await normalWindow.buffer();
        const bufferName = await winBuffer.getName();
        if (!bufferName.includes("poem.txt")) {
          throw new Error(
            `Expected buffer name to contain poem.txt, got ${bufferName}`,
          );
        }
      });
    });
  });

  it("'Enter' key opens file with multiple non-magenta windows", async () => {
    await withDriver({}, async (driver) => {
      await driver.nvim.call("nvim_command", ["new second_window"]);

      await driver.showSidebar();

      // Add file to context using the helper method
      await driver.addContextFiles("poem.txt");

      const pos = await driver.assertDisplayBufferContains(`\`poem.txt\``);

      await driver.triggerDisplayBufferKey(pos, "<CR>");
      await driver.assertWindowCount(4);

      const poemWindow = await driver.findWindow(async (w) => {
        const buffer = await w.buffer();
        const name = await buffer.getName();
        return name.indexOf("poem.txt") > -1;
      });

      const isMagenta = await poemWindow.getVar("magenta");
      expect(isMagenta, "we opened in a non-magenta window").toBeFalsy();
    });
  });

  it("'Enter' key opens file when sidebar is on the left", async () => {
    await withDriver(
      { options: { sidebarPosition: "left" } },
      async (driver) => {
        const initialWindow = (await getAllWindows(driver.nvim))[0];
        await driver.showSidebar();
        await driver.nvim.call("nvim_win_close", [initialWindow.id, true]);
        expect(
          (await getAllWindows(driver.nvim)).length,
          "now only magenta windows open",
        ).toBe(2);

        await driver.addContextFiles("poem.txt");

        const displayWindow = driver.getVisibleState().displayWindow;

        // Get position of the file line to click on
        const pos = await driver.assertDisplayBufferContains(`\`poem.txt\``);

        await driver.triggerDisplayBufferKey(pos, "<CR>");

        await driver.assertWindowCount(3, "Enter should open a new window");

        const fileWindow = await driver.findWindow(async (w) => {
          const buf = await w.buffer();
          const name = await buf.getName();
          return name.includes("poem.txt");
        });
        expect(fileWindow).toBeDefined();

        // Verify window position is on the right (col index 1 is higher for windows on the right)
        const fileWinPos = await fileWindow.getPosition();
        const displayWinPos = await displayWindow.getPosition();
        expect(fileWinPos[1]).toBeGreaterThan(displayWinPos[1]);
      },
    );
  });

  it("'Enter' key opens file when sidebar is on the right", async () => {
    await withDriver(
      { options: { sidebarPosition: "right" } },
      async (driver) => {
        const initialWindow = (await getAllWindows(driver.nvim))[0];
        await driver.showSidebar();
        await driver.nvim.call("nvim_win_close", [initialWindow.id, true]);
        expect(
          (await getAllWindows(driver.nvim)).length,
          "now only magenta windows open",
        ).toBe(2);

        await driver.addContextFiles("poem.txt");

        const displayWindow = driver.getVisibleState().displayWindow;

        // Get position of the file line to click on
        const pos = await driver.assertDisplayBufferContains(`\`poem.txt\``);

        await driver.triggerDisplayBufferKey(pos, "<CR>");

        await driver.assertWindowCount(3, "Enter should open a new window");

        const fileWindow = await driver.findWindow(async (w) => {
          const buf = await w.buffer();
          const name = await buf.getName();
          return name.includes("poem.txt");
        });
        expect(fileWindow).toBeDefined();

        // Verify window position is on the left (col index 1 is lower for windows on the left)
        const fileWinPos = await fileWindow.getPosition();
        const displayWinPos = await displayWindow.getPosition();
        expect(fileWinPos[1]).toBeLessThan(displayWinPos[1]);
      },
    );
  });
});

it("context-files end-to-end", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.addContextFiles("poem.txt");

    await driver.assertDisplayBufferContains(`\
# context:
- \`poem.txt\``);

    await driver.inputMagentaText("check out this file");
    await driver.send();
    const request = await driver.mockAnthropic.awaitPendingUserRequest();
    expect(request.messages).toMatchSnapshot();
  });
});

it("removes deleted files from context during updates", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Get the context manager from the driver
    const contextManager =
      driver.magenta.chat.getActiveThread().context.contextManager;

    const cwd = await getcwd(driver.nvim);
    const tempFilePath = resolveFilePath(
      cwd,
      "temp-file.txt" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    // Create a temporary file
    await fs.promises.writeFile(tempFilePath, "temporary content");

    // Add file to context using the helper method
    await driver.addContextFiles("temp-file.txt");

    // Verify file is in context
    expect(contextManager.files[tempFilePath]).toBeDefined();

    // Get initial context update
    const firstUpdates = await contextManager.getContextUpdate();
    expect(firstUpdates[tempFilePath]).toBeDefined();

    // Delete the file
    await fs.promises.unlink(tempFilePath);

    // Get context updates after deletion
    const secondUpdates = await contextManager.getContextUpdate();

    // File should be removed from context and file-deleted update should be returned
    expect(contextManager.files[tempFilePath]).toBeUndefined();
    expect(secondUpdates[tempFilePath]).toBeDefined();
    expect(secondUpdates[tempFilePath].update.status).toBe("ok");
    if (secondUpdates[tempFilePath].update.status === "ok") {
      expect(secondUpdates[tempFilePath].update.value.type).toBe(
        "file-deleted",
      );
    }
  });
});

it("handles file deletion during buffer tracking", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Get the context manager from the driver
    const contextManager =
      driver.magenta.chat.getActiveThread().context.contextManager;

    const cwd = await getcwd(driver.nvim);
    const tempFilePath = resolveFilePath(
      cwd,
      "temp-tracked.txt" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    // Create a temporary file
    await fs.promises.writeFile(tempFilePath, "tracked content");

    // Add file to context using the helper method
    await driver.addContextFiles("temp-tracked.txt");

    // Open the file in a buffer to start tracking it
    await driver.editFile("temp-tracked.txt");

    // Get initial context update to establish buffer tracking
    const firstUpdates = await contextManager.getContextUpdate();
    expect(firstUpdates[tempFilePath]).toBeDefined();

    // Delete the file while it's being tracked
    await fs.promises.unlink(tempFilePath);

    // Get context updates after deletion
    const secondUpdates = await contextManager.getContextUpdate();

    // File should be removed from context and file-deleted update should be returned
    expect(contextManager.files[tempFilePath]).toBeUndefined();
    expect(secondUpdates[tempFilePath]).toBeDefined();
    expect(secondUpdates[tempFilePath].update.status).toBe("ok");
    if (secondUpdates[tempFilePath].update.status === "ok") {
      expect(secondUpdates[tempFilePath].update.value.type).toBe(
        "file-deleted",
      );
    }
  });
});

it("context-files multiple, weird path names", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.addContextFiles("poem.txt", "poem 3.txt");

    await driver.assertDisplayBufferContains(`\
# context:
- \`poem.txt\`
- \`poem 3.txt\``);

    await driver.inputMagentaText("check out this file");
    await driver.send();
    const request = await driver.mockAnthropic.awaitPendingStream();
    expect(request.messages).toMatchSnapshot();
  });
});

it("adding a binary file sends the initial update. Further messages do not send further updates.", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Get the context manager from the driver
    const contextManager =
      driver.magenta.chat.getActiveThread().context.contextManager;

    // Add a binary file to context using the helper method
    await driver.addContextFiles("test.jpg");

    // First getContextUpdate call should return the initial content
    const firstUpdates = await contextManager.getContextUpdate();
    const cwd = await getcwd(driver.nvim);
    const absFilePath = resolveFilePath(
      cwd,
      "test.jpg" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    expect(firstUpdates[absFilePath]).toBeDefined();
    const firstUpdate = firstUpdates[absFilePath];
    expect(firstUpdate.update.status).toBe("ok");
    if (firstUpdate.update.status === "ok") {
      expect(firstUpdate.update.value.type).toBe("whole-file");
      expect(firstUpdate.absFilePath).toBe(absFilePath);
      expect(firstUpdate.relFilePath).toBe("test.jpg");
      // Content should be base64 encoded binary data
      expect(
        (
          (firstUpdate.update.value as WholeFileUpdate)
            .content[0] as ProviderImageContent
        ).source.data,
      ).toMatch(/^[A-Za-z0-9+/]+=*$/);
    }

    // Second getContextUpdate call should return no updates (file hasn't changed)
    const secondUpdates = await contextManager.getContextUpdate();
    expect(Object.keys(secondUpdates).length).toBe(0);
  });
});

it("removing a binary file on disk removes it from the context and sends a delete message", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Get the context manager from the driver
    const contextManager =
      driver.magenta.chat.getActiveThread().context.contextManager;

    const cwd = await getcwd(driver.nvim);
    const testFilePath = resolveFilePath(
      cwd,
      "test.jpg" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );

    // Add file to context using the helper method
    await driver.addContextFiles("test.jpg");

    // Verify file is in context
    expect(contextManager.files[testFilePath]).toBeDefined();

    // Get initial context update
    const firstUpdates = await contextManager.getContextUpdate();
    expect(firstUpdates[testFilePath]).toBeDefined();

    // Delete the file
    await fs.promises.unlink(testFilePath);

    // Get context updates after deletion
    const secondUpdates = await contextManager.getContextUpdate();

    // File should be removed from context and file-deleted update should be returned
    expect(contextManager.files[testFilePath]).toBeUndefined();
    expect(secondUpdates[testFilePath]).toBeDefined();
    expect(secondUpdates[testFilePath].update.status).toBe("ok");
    if (secondUpdates[testFilePath].update.status === "ok") {
      expect(secondUpdates[testFilePath].update.value.type).toBe(
        "file-deleted",
      );
    }
  });
});

it("issuing a getFile request adds the file to the context but doesn't send its contents twice", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Get the context manager from the driver
    const contextManager =
      driver.magenta.chat.getActiveThread().context.contextManager;

    // Verify context is empty initially
    expect(contextManager.files).toEqual({});

    // Issue a getFile request for a binary file
    await driver.inputMagentaText(`Please analyze the image test.jpg`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "I'll analyze the image",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "img_request" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: "test.jpg" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`test.jpg\``);

    // Handle the auto-respond message
    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
    const providerMessages = toolResultRequest.getProviderMessages();

    const flattenedMessages = providerMessages.flatMap((msg) =>
      msg.content.map(
        (content) =>
          `${msg.role};${content.type};${content.type === "text" ? content.text : ""}`,
      ),
    );

    expect(flattenedMessages).toEqual([
      "user;text;Please analyze the image test.jpg",
      "user;system_reminder;",
      "assistant;text;I'll analyze the image",
      "assistant;tool_use;",
      "user;tool_result;",
      "user;system_reminder;",
    ]);

    // Verify the tool result contains the file content exactly once
    // Now the file should be in context
    const cwd = await getcwd(driver.nvim);
    const absFilePath = resolveFilePath(
      cwd,
      "test.jpg" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );
    expect(contextManager.files[absFilePath]).toBeDefined();
    expect(contextManager.files[absFilePath].fileTypeInfo.category).toBe(
      "image",
    );
  });
});

it("autoContext loads on startup and after new-thread", async () => {
  const testOptions = {
    autoContext: [`test-auto-context.md`],
  };

  await withDriver({ options: testOptions }, async (driver) => {
    // Show sidebar and verify autoContext is loaded
    await driver.showSidebar();
    await driver.assertDisplayBufferContains(
      `# context:\n- \`test-auto-context.md\``,
    );

    // Create new thread and verify autoContext is loaded
    await driver.magenta.command("new-thread");
    await driver.assertDisplayBufferContains(
      `# context:\n- \`test-auto-context.md\``,
    );

    // Check that the content is included in messages when sending
    await driver.inputMagentaText("hello");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    expect(request.messages).toContainEqual(
      expect.objectContaining<ProviderMessage>({
        role: "user",

        content: expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            text: expect.stringContaining("test-auto-context.md"),
          }),
        ]) as ProviderMessageContent[],
      }),
    );
  });
});

it("includes PDF file in context and sends summary in context updates", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        // Create a multi-page PDF for testing
        const { PDFDocument } = await import("pdf-lib");
        const pdfDoc = await PDFDocument.create();

        pdfDoc.addPage([600, 400]);
        pdfDoc.addPage([600, 400]);
        pdfDoc.addPage([600, 400]);
        const pdfBytes = await pdfDoc.save();
        const fs = await import("fs/promises");
        const path = await import("path");
        const testPdfPath = path.join(tmpDir, "context-test.pdf");
        await fs.writeFile(testPdfPath, pdfBytes);
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Add PDF file to context using the helper method
      await driver.addContextFiles("context-test.pdf");

      await driver.inputMagentaText("read the first page of this file");
      await driver.send();

      {
        const request = await driver.mockAnthropic.awaitPendingStream();

        await driver.assertDisplayBufferContains(
          "- `context-test.pdf` (summary)",
        );
        // assert context updates contain PDF summary
        const contextUpdateMsg = request.messages.find(
          (msg) =>
            msg.role === "user" &&
            Array.isArray(msg.content) &&
            msg.content.some(
              (c: { type: string; text?: string }) =>
                c.type === "text" && c.text?.includes("<context_update>"),
            ),
        );
        expect(contextUpdateMsg).toBeDefined();
        const content = contextUpdateMsg!.content;
        expect(Array.isArray(content)).toBe(true);
        if (Array.isArray(content)) {
          const textContent = content.find(
            (c: { type: string }) => c.type === "text",
          ) as { type: string; text: string } | undefined;
          expect(textContent?.type).toBe("text");
          if (textContent?.type === "text") {
            expect(textContent.text).toContain("PDF Document:");
            expect(textContent.text).toContain("context-test.pdf");
            expect(textContent.text).toContain("Pages: 3");
          }
        }
        request.respond({
          text: "let me read that file",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "tool_request_id" as ToolRequestId,
                toolName: "get_file" as ToolName,
                input: {
                  filePath: "context-test.pdf",
                  pdfPage: 1,
                },
              },
            },
          ],
          stopReason: "tool_use",
        });
      }

      // wait for autorespond after get_file finishes
      {
        await driver.assertDisplayBufferContains("`context-test.pdf` (page 1)");
        const request = await driver.mockAnthropic.awaitPendingStream();
        const providerMessages = request.getProviderMessages();
        // Tool result with document is second-to-last, system reminder is last
        const toolResultMessage = providerMessages[providerMessages.length - 2];

        // Validate structure - document blocks are siblings to tool_result, not nested
        expect(toolResultMessage).toEqual({
          role: "user",
          content: [
            {
              id: "tool_request_id",
              type: "tool_result",
              result: {
                status: "ok",
                value: [], // Documents are extracted as siblings
              },
            },
            {
              type: "document",
              title: "context-test.pdf - Page 1",
              source: {
                type: "base64",
                media_type: "application/pdf",

                data: expect.any(String) as string, // Ignore the actual PDF data
              },
            },
          ],
        });

        // Verify system reminder is in last message
        expect(providerMessages[providerMessages.length - 1]).toEqual({
          role: "user",
          content: [
            {
              type: "system_reminder",
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              text: expect.stringContaining("Remember the skills"),
            },
          ],
        });

        request.respond({
          text: "ok, done",
          toolRequests: [],
          stopReason: "end_turn",
        });
      }

      await driver.assertDisplayBufferContains(
        "`context-test.pdf` (summary, page 1)",
      );
    },
  );
});
