import { describe, expect, it } from "vitest";
import { TMP_DIR, withDriver } from "../test/preamble";
import { pollUntil } from "../utils/async";
import { getAllWindows, getcwd } from "../nvim/nvim";
import {
  resolveFilePath,
  detectFileType,
  type AbsFilePath,
  type RelFilePath,
  type UnresolvedFilePath,
} from "../utils/files";
import type { Line } from "../nvim/buffer";
import type { DiffUpdate, WholeFileUpdate } from "./context-manager";
import type { ToolRequestId } from "../tools/toolManager";
import fs from "node:fs";
import type { ToolName } from "../tools/types";

const testFilePath = `${TMP_DIR}/poem.txt` as AbsFilePath;

describe("unit tests", () => {
  it("returns full file contents on first getContextUpdate and no updates on second call when file hasn't changed", async () => {
    await withDriver({}, async (driver) => {
      const testFilePath = `${TMP_DIR}/poem.txt`;

      await driver.showSidebar();

      // Get the context manager from the driver
      const contextManager =
        driver.magenta.chat.getActiveThread().context.contextManager;

      const cwd = await getcwd(driver.nvim);
      const absFilePath = resolveFilePath(
        cwd,
        testFilePath as UnresolvedFilePath,
      );

      // Get file type info and add file to context
      const fileTypeInfo = await detectFileType(absFilePath);
      contextManager.myDispatch({
        type: "add-file-context",
        relFilePath: "poem.txt" as RelFilePath,
        absFilePath,
        fileTypeInfo,
      });

      // Get context updates - first call
      const firstUpdates = await contextManager.getContextUpdate();

      // Check that the update contains the file
      expect(firstUpdates[absFilePath]).toBeDefined();

      // Check that it's a whole-file update
      const firstUpdate = firstUpdates[absFilePath];
      expect(firstUpdate.update.status).toBe("ok");
      if (firstUpdate.update.status === "ok") {
        expect(firstUpdate.update.value.type).toBe("whole-file");
        expect(firstUpdate.absFilePath).toBe(absFilePath);
        expect((firstUpdate.update.value as WholeFileUpdate).content).toContain(
          "Moonlight whispers through the trees",
        );
      }

      // Get context updates second time without changing the file
      const secondUpdates = await contextManager.getContextUpdate();

      // The second update should be empty if no changes were made
      expect(Object.keys(secondUpdates).length).toBe(0);
    });
  });

  it("returns diff when file is edited in a buffer", async () => {
    await withDriver({}, async (driver) => {
      const testFilePath = `${TMP_DIR}/poem.txt`;
      await driver.showSidebar();

      // Get the context manager from the driver
      const contextManager =
        driver.magenta.chat.getActiveThread().context.contextManager;

      const cwd = await getcwd(driver.nvim);
      const absFilePath = resolveFilePath(
        cwd,
        testFilePath as UnresolvedFilePath,
      );

      // Get file type info and add the file to context
      const fileTypeInfo = await detectFileType(absFilePath);
      contextManager.myDispatch({
        type: "add-file-context",
        relFilePath: testFilePath as RelFilePath,
        absFilePath,
        fileTypeInfo,
      });

      // First, edit the file to track the buffer
      await driver.editFile(testFilePath);
      await contextManager.getContextUpdate();

      const window = await driver.findWindow(async (w) => {
        const buffer = await w.buffer();
        const bufName = await buffer.getName();
        return bufName.indexOf(testFilePath) > -1;
      });
      const buffer = await window.buffer();
      await buffer.setLines({
        start: 0,
        end: 1,
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

  it("returns diff when file is edited on disk", async () => {
    await withDriver({}, async (driver) => {
      const testFilePath = `${TMP_DIR}/poem.txt`;
      await driver.showSidebar();

      // Get the context manager from the driver
      const contextManager =
        driver.magenta.chat.getActiveThread().context.contextManager;

      const cwd = await getcwd(driver.nvim);
      const absFilePath = resolveFilePath(
        cwd,
        testFilePath as UnresolvedFilePath,
      );

      // Get file type info and add a file to context
      const fileTypeInfo = await detectFileType(absFilePath);
      contextManager.myDispatch({
        type: "add-file-context",
        relFilePath: "poem.txt" as RelFilePath,
        absFilePath,
        fileTypeInfo,
      });

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

  it("avoids sending redundant context updates after tool application", async () => {
    await withDriver({}, async (driver) => {
      const testFilePath = `${TMP_DIR}/poem.txt`;
      await driver.showSidebar();

      // Add file to context using the context-files command
      await driver.nvim.call("nvim_command", [
        `Magenta context-files '${testFilePath}'`,
      ]);

      // Wait for context to be added to the display
      await pollUntil(async () => {
        const content = await driver.getDisplayBufferText();
        if (!content.includes(`- \`${testFilePath}\``)) {
          throw new Error("Context file not yet displayed");
        }
      });

      // Start a conversation and send a message requesting a modification
      await driver.inputMagentaText(`Add a new line to the poem.txt file`);
      await driver.send();

      // Respond with a tool call that will modify the file
      const request1 = await driver.mockAnthropic.awaitPendingRequest();
      request1.respond({
        stopReason: "tool_use",
        text: "I'll add a new line to the poem",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "tool1" as ToolRequestId,
              toolName: "insert" as ToolName,
              input: {
                filePath: testFilePath as UnresolvedFilePath,
                insertAfter: "Paint their stories in the night.",
                content: "\nAdded by Magenta tool call",
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✏️ Insert [[ +2 ]]");
      await driver.assertDisplayBufferContains("Success");

      {
        const request = await driver.mockAnthropic.awaitPendingRequest();
        expect(
          request.messages[request.messages.length - 1],
          "auto-respond request goes out",
        ).toEqual({
          content: [
            {
              id: "tool1",
              result: {
                status: "ok",
                value: [
                  {
                    type: "text",
                    text: "Successfully applied edits.",
                  },
                ],
              },
              type: "tool_result",
            },
          ],
          role: "user",
        });
      }
      {
        const request2 = await driver.mockAnthropic.awaitPendingRequest();
        request2.respond({
          stopReason: "end_turn",
          text: "I did it!",
          toolRequests: [],
        });

        const request = await driver.mockAnthropic.awaitStopped();
        expect(
          request.messages[request.messages.length - 1],
          "end_turn request stopped agent",
        ).toEqual({
          content: [
            {
              id: "tool1",
              result: {
                status: "ok",
                value: [
                  {
                    type: "text",
                    text: "Successfully applied edits.",
                  },
                ],
              },
              type: "tool_result",
            },
          ],
          role: "user",
        });
      }

      await driver.inputMagentaText(`testing`);
      await driver.send();

      const userRequest = await driver.mockAnthropic.awaitPendingUserRequest();

      expect(
        userRequest.messages[userRequest.messages.length - 1],
        "next user message does not have context update",
      ).toEqual({
        content: [
          {
            type: "text",
            text: "testing",
          },
        ],
        role: "user",
      });
    });
  });

  it("sends update if the file was edited pre-insert", async () => {
    await withDriver({}, async (driver) => {
      const testFilePath = `${TMP_DIR}/poem.txt`;
      await driver.showSidebar();

      await driver.nvim.call("nvim_command", [
        `Magenta context-files '${testFilePath}'`,
      ]);

      // Wait for context to be added to the display
      await pollUntil(async () => {
        const content = await driver.getDisplayBufferText();
        if (!content.includes(`- \`${testFilePath}\``)) {
          throw new Error("Context file not yet displayed");
        }
      });

      const pos = await driver.assertDisplayBufferContains(
        `- \`${testFilePath}\``,
      );
      await driver.triggerDisplayBufferKey(pos, "<CR>");

      const poemWindow = await driver.findWindow(async (w) => {
        const winBuffer = await w.buffer();
        const bufferName = await winBuffer.getName();
        return bufferName.includes(testFilePath);
      });
      const poemBuffer = await poemWindow.buffer();
      await driver.inputMagentaText(`Add a new line to the poem.txt file`);
      await driver.send();

      const request3 = await driver.mockAnthropic.awaitPendingRequest();
      request3.respond({
        stopReason: "tool_use",
        text: "I'll add a new line to the poem",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "tool1" as ToolRequestId,
              toolName: "insert" as ToolName,
              input: {
                filePath: testFilePath as UnresolvedFilePath,
                insertAfter: "Paint their stories in the night.",
                content: "\nAdded by Magenta tool call",
              },
            },
          },
        ],
      });
      const autoRespondCatcher = driver.interceptSendMessage();

      await driver.assertDisplayBufferContains("✏️ Insert [[ +2 ]]");
      await driver.assertDisplayBufferContains("Success");

      const args = await autoRespondCatcher.promise;

      // edit the input buffer before the end turn response
      await poemBuffer.setLines({
        start: 0,
        end: 1,
        lines: ["changed first line" as Line],
      });

      // this promise will not resolve until we respond via mockAnthropic
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      autoRespondCatcher.execute(...args);

      {
        const request = await driver.mockAnthropic.awaitPendingRequest();
        expect(
          request.messages[request.messages.length - 2],
          "auto-respond request goes out",
        ).toEqual({
          content: [
            {
              id: "tool1",
              result: {
                status: "ok",
                value: [
                  {
                    type: "text",
                    text: "Successfully applied edits.",
                  },
                ],
              },
              type: "tool_result",
            },
          ],
          role: "user",
        });

        expect(
          request.messages[request.messages.length - 1],
          "auto-respond request goes out",
        ).toMatchSnapshot();
      }
    });
  });
});

describe("key bindings", () => {
  it("'dd' key correctly removes the middle file when three files are in context", async () => {
    await withDriver({}, async (driver) => {
      // Open context sidebar
      await driver.showSidebar();

      const poemFile = `${TMP_DIR}/poem.txt`;
      const poem3file = `${TMP_DIR}/poem 3.txt`;
      const contextFile = "context.md";

      await driver.nvim.call("nvim_command", [
        `Magenta context-files '${poem3file}' '${contextFile}' '${poemFile}'`,
      ]);

      // Wait for all context files to be added to the display
      await pollUntil(async () => {
        const content = await driver.getDisplayBufferText();
        if (
          !content.includes(`- \`${poem3file}\``) ||
          !content.includes(`- \`${contextFile}\``) ||
          !content.includes(`- \`${poemFile}\``)
        ) {
          throw new Error("Not all context files displayed yet");
        }
      });

      const middleFilePos = await driver.assertDisplayBufferContains(
        `- \`${contextFile}\``,
      );

      // Press dd on the middle file to remove it
      await driver.triggerDisplayBufferKey(middleFilePos, "dd");

      // Wait for the file to be removed from context
      await pollUntil(async () => {
        const content = await driver.getDisplayBufferText();
        if (content.includes(`- \`${contextFile}\``)) {
          throw new Error("Context file not yet removed");
        }
        if (
          !content.includes(`- \`${poem3file}\``) ||
          !content.includes(`- \`${poemFile}\``)
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

      // Add file to context using the context-files command
      await driver.nvim.call("nvim_command", [
        `Magenta context-files '${testFilePath}'`,
      ]);

      const pos = await driver.assertDisplayBufferContains(
        `\`${testFilePath}\``,
      );

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

      // Add file to context using the context-files command
      await driver.nvim.call("nvim_command", [
        `Magenta context-files '${testFilePath}'`,
      ]);

      const pos = await driver.assertDisplayBufferContains(
        `\`${testFilePath}\``,
      );

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

        await driver.nvim.call("nvim_command", [
          `Magenta context-files '${testFilePath}'`,
        ]);

        const displayWindow = driver.getVisibleState().displayWindow;

        // Get position of the file line to click on
        const pos = await driver.assertDisplayBufferContains(
          `\`${testFilePath}\``,
        );

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

        await driver.nvim.call("nvim_command", [
          `Magenta context-files '${testFilePath}'`,
        ]);

        const displayWindow = driver.getVisibleState().displayWindow;

        // Get position of the file line to click on
        const pos = await driver.assertDisplayBufferContains(
          `\`${testFilePath}\``,
        );

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
    await driver.nvim.call("nvim_command", [
      `Magenta context-files './${TMP_DIR}/poem.txt'`,
    ]);

    await driver.assertDisplayBufferContains(`\
# context:
- \`${TMP_DIR}/poem.txt\``);

    await driver.inputMagentaText("check out this file");
    await driver.send();
    const request = await driver.mockAnthropic.awaitPendingUserRequest();
    expect(request.messages).toMatchSnapshot();
  });
});

it("context-files multiple, weird path names", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.nvim.call("nvim_command", [
      `Magenta context-files './${TMP_DIR}/poem.txt' './${TMP_DIR}/poem 3.txt'`,
    ]);

    await driver.assertDisplayBufferContains(`\
# context:
- \`${TMP_DIR}/poem.txt\`
- \`${TMP_DIR}/poem 3.txt\``);

    await driver.inputMagentaText("check out this file");
    await driver.send();
    await pollUntil(() => {
      if (driver.mockAnthropic.requests.length != 1) {
        throw new Error(`Expected a message to be pending.`);
      }
    });
    const request =
      driver.mockAnthropic.requests[driver.mockAnthropic.requests.length - 1];
    expect(request.messages).toMatchSnapshot();
  });
});

it("autoContext loads on startup and after clear", async () => {
  const testOptions = {
    autoContext: [`${TMP_DIR}/test-auto-context.md`],
  };

  await withDriver({ options: testOptions }, async (driver) => {
    // Show sidebar and verify autoContext is loaded
    await driver.showSidebar();
    await driver.assertDisplayBufferContains(
      `# context:\n- \`${TMP_DIR}/test-auto-context.md\``,
    );

    // Clear thread and verify autoContext is reloaded
    await driver.clear();
    await driver.assertDisplayBufferContains(
      `# context:\n- \`${TMP_DIR}/test-auto-context.md\``,
    );

    // Check that the content is included in messages when sending
    await driver.inputMagentaText("hello");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    // Check that file content is included in the request
    const fileContent = request.messages.find(
      (msg) =>
        msg.role === "user" &&
        typeof msg.content === "object" &&
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        (msg.content[0] as any).text.includes("test-auto-context.md"),
    );
    expect(fileContent).toBeTruthy();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const text = (fileContent?.content[0] as any).text;
    expect(text).toContain("This is test auto-context content");
    expect(text).toContain("Multiple lines");
    expect(text).toContain("for testing");
  });
});
