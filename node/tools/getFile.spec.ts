import type { ToolRequestId } from "./toolManager.ts";
import { expect, it } from "vitest";
import { withDriver, assertToolResultContainsText } from "../test/preamble.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { ToolName } from "./types.ts";
import type { BufNr } from "../nvim/buffer.ts";

it("render the getFile tool.", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`Try reading the file poem.txt`);
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingRequest();
    request1.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "request_id" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: "./poem.txt" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`./poem.txt\``);
  });
});

it("getFile automatically allows files matching getFileAutoAllowGlobs", async () => {
  await withDriver(
    {
      options: {
        getFileAutoAllowGlobs: [".secret", "*.log"],
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Test that .secret is automatically allowed
      await driver.inputMagentaText(`Try reading the file .secret`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "request_id" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: ".secret" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      // Should be automatically approved, not show approval dialog
      await driver.assertDisplayBufferContains(`👀✅ \`.secret\``);
    },
  );
});

it("getFile automatically allows files matching glob patterns", async () => {
  await withDriver(
    {
      options: {
        getFileAutoAllowGlobs: ["*.log", "config/*"],
      },
      setupFiles: async (tmpDir) => {
        // Create some test files
        const fs = await import("fs/promises");
        const path = await import("path");

        await fs.writeFile(path.join(tmpDir, "test.log"), "log content");
        await fs.mkdir(path.join(tmpDir, "config"));
        await fs.writeFile(path.join(tmpDir, "config/settings.json"), "{}");
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Test that .log files are automatically allowed
      await driver.inputMagentaText(`Try reading the file test.log`);
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingRequest();
      request1.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "request_id_1" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "test.log" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`test.log\``);

      // Handle the first request response
      const toolResultRequest1 =
        await driver.mockAnthropic.awaitPendingRequest();
      toolResultRequest1.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've read the log file.",
      });

      // Test that config/* files are automatically allowed
      await driver.inputMagentaText(
        `Try reading the file config/settings.json`,
      );
      await driver.send();

      const request2 = await driver.mockAnthropic.awaitPendingRequest();
      request2.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "request_id_2" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "config/settings.json" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`config/settings.json\``);
    },
  );
});

it("getFile still requires approval for files not matching getFileAutoAllowGlobs", async () => {
  await withDriver(
    {
      options: {
        getFileAutoAllowGlobs: ["*.log"],
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Test that .secret is NOT automatically allowed since it doesn't match *.log
      await driver.inputMagentaText(`Try reading the file .secret`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "request_id" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: ".secret" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      // Should still require approval
      await driver.assertDisplayBufferContains(
        `👀⏳ May I read file \`.secret\`?`,
      );
    },
  );
});

it("getFile rejection", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`Try reading the file .secret`);
    await driver.send();

    const request2 = await driver.mockAnthropic.awaitPendingRequest();
    request2.respond({
      stopReason: "end_turn",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: ".secret" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`\
👀⏳ May I read file \`.secret\`?`);
    const noPos = await driver.assertDisplayBufferContains("[ NO ]");

    await driver.triggerDisplayBufferKey(noPos, "<CR>");
    await driver.assertDisplayBufferContains("👀❌ `.secret`");
  });
});

it("displays approval dialog with proper box formatting", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`Try reading the file .secret`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.respond({
      stopReason: "end_turn",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: ".secret" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    // Wait for the user approval prompt
    await driver.assertDisplayBufferContains("👀⏳ May I read file `.secret`?");

    // Verify the box formatting is displayed correctly
    await driver.assertDisplayBufferContains(`\
┌────────────────┐
│ [ NO ] [ YES ] │
└────────────────┘`);

    // Test that clicking YES works
    const yesPos = await driver.assertDisplayBufferContains("[ YES ]");
    await driver.triggerDisplayBufferKey(yesPos, "<CR>");

    // Verify file is read successfully
    await driver.assertDisplayBufferContains("👀✅ `.secret`");
  });
});

it("getFile approval", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`Try reading the file .secret`);
    await driver.send();

    const request3 = await driver.mockAnthropic.awaitPendingRequest();
    request3.respond({
      stopReason: "end_turn",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: ".secret" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`\
👀⏳ May I read file \`.secret\`?`);
    const okPos = await driver.assertDisplayBufferContains("[ YES ]");

    await driver.triggerDisplayBufferKey(okPos, "<CR>");
    await driver.assertDisplayBufferContains(`\
👀✅ \`.secret\``);
  });
});

// TODO: how to setup gitignore in the tmp test dir?
it.skip("getFile requests approval for gitignored file", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`Try reading the file node_modules/test`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.respond({
      stopReason: "end_turn",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: "node_modules/test" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`\
👀⏳ May I read file \`node_modules/test\`? **[ NO ]** **[ OK ]**`);
  });
});

it("getFile requests approval for file outside cwd", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`Try reading the file /tmp/file`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.respond({
      stopReason: "end_turn",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: "/tmp/file" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`\
👀⏳ May I read file \`/tmp/file\`?`);
  });
});

it("getFile returns early when file is already in context", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Add the file to context first
    await driver.addContextFiles("./poem.txt");

    // Now try to read the same file without force
    await driver.inputMagentaText(`Try reading the file ./poem.txt`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "request_id" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: "./poem.txt" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    // Should return the early message about file already being in context
    await driver.assertDisplayBufferContains(`👀✅ \`./poem.txt\``);

    // Check the actual response content in the next request
    const toolResultRequest = await driver.mockAnthropic.awaitPendingRequest();
    const toolResultMessage =
      toolResultRequest.messages[toolResultRequest.messages.length - 1];

    if (
      toolResultMessage.role === "user" &&
      Array.isArray(toolResultMessage.content)
    ) {
      const toolResult = toolResultMessage.content.find(
        (item) => item.type === "tool_result",
      );
      if (toolResult && toolResult.type === "tool_result") {
        assertToolResultContainsText(
          toolResult,
          "already part of the thread context",
        );
      }
    }
  });
});

it("getFile reads file when force is true even if already in context", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Add the file to context first
    await driver.addContextFiles("./poem.txt");

    await driver.inputMagentaText(`Try reading the file ./poem.txt with force`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "request_id" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: "./poem.txt" as UnresolvedFilePath,
              force: true,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`./poem.txt\``);

    const toolResultRequest = await driver.mockAnthropic.awaitPendingRequest();
    const toolResultMessage =
      toolResultRequest.messages[toolResultRequest.messages.length - 1];

    if (
      toolResultMessage.role === "user" &&
      Array.isArray(toolResultMessage.content)
    ) {
      const toolResult = toolResultMessage.content.find(
        (item) => item.type === "tool_result",
      );
      if (toolResult && toolResult.type === "tool_result") {
        assertToolResultContainsText(
          toolResult,
          "Moonlight whispers through the trees",
        );

        // Verify that the "already part of the thread context" message is NOT present
        const result = toolResult.result;
        if (result.status === "ok") {
          const hasContextText = result.value.some((item) => {
            if (typeof item === "object" && item.type === "text") {
              return item.text.includes("already part of the thread context");
            }
            return false;
          });
          expect(hasContextText).toBe(false);
        }
      }
    }
  });
});

it("getFile adds file to context after reading", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Make sure context is empty initially
    expect(driver.magenta.chat.getActiveThread().contextManager.files).toEqual(
      {},
    );

    // Read a file
    await driver.inputMagentaText(`Try reading the file ./poem.txt`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "request_id" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: "./poem.txt" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`./poem.txt\``);

    // Handle the auto-respond message
    const toolResultRequest = await driver.mockAnthropic.awaitPendingRequest();
    toolResultRequest.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I've successfully read the file.",
    });

    await driver.assertDisplayBufferContains("# context:");
    await driver.assertDisplayBufferContains("- `poem.txt`");
  });
});

it("getFile reads unloaded buffer", async () => {
  await withDriver({}, async (driver) => {
    // First, create a dummy buffer to avoid "cannot unload last buffer" error
    await driver.nvim.call("nvim_command", ["new"]);

    // Then open the file to create a buffer
    await driver.nvim.call("nvim_command", ["edit poem.txt"]);

    // next, open the sidebar
    await driver.showSidebar();
    // Get the buffer number
    const bufNr = (await driver.nvim.call("nvim_eval", [
      "bufnr('poem.txt')",
    ])) as BufNr;

    // Verify buffer is loaded initially
    const isLoadedInitially = await driver.nvim.call("nvim_buf_is_loaded", [
      bufNr,
    ]);
    expect(isLoadedInitially).toBe(true);

    // Unload the buffer using nvim_exec_lua
    await driver.nvim.call("nvim_exec_lua", [
      `vim.api.nvim_buf_call(${bufNr}, function() vim.cmd('bunload') end)`,
      [],
    ]);

    // Verify buffer is unloaded
    const isLoaded = await driver.nvim.call("nvim_buf_is_loaded", [bufNr]);
    expect(isLoaded).toBe(false);

    // Ensure sidebar is still visible after file operations
    await driver.showSidebar();

    // Now try to read the file via getFile tool
    await driver.inputMagentaText(`Try reading the file ./poem.txt`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingRequest();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "request_id" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: "./poem.txt" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`./poem.txt\``);

    // Check that the file contents are properly returned
    const toolResultRequest = await driver.mockAnthropic.awaitPendingRequest();
    const toolResultMessage =
      toolResultRequest.messages[toolResultRequest.messages.length - 1];

    expect(toolResultMessage.role).toBe("user");
    expect(Array.isArray(toolResultMessage.content)).toBe(true);

    const toolResult = toolResultMessage.content.find(
      (item) => item.type === "tool_result",
    );
    expect(toolResult).toBeDefined();
    if (!toolResult || toolResult.type !== "tool_result") {
      throw new Error("Expected tool result");
    }

    assertToolResultContainsText(
      toolResult,
      "Moonlight whispers through the trees",
    );

    // Verify the full content is returned, not empty content
    const result = toolResult.result;
    expect(result.status).toBe("ok");

    if (result.status !== "ok") {
      throw new Error("Expected ok status");
    }

    const content = result.value.find((item) => item.type === "text");
    expect(content).toBeDefined();
    if (!content || content.type !== "text") {
      throw new Error("Expected text content");
    }

    // Should contain the full poem, not be empty
    expect(content.text.trim()).not.toBe("");
    expect(content.text).toContain("Moonlight whispers through the trees");
    expect(content.text).toContain("Silver shadows dance with ease");

    // Respond to complete the conversation
    toolResultRequest.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I've successfully read the file.",
    });
  });
});
