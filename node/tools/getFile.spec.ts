import type { ToolRequestId } from "./toolManager.ts";
import { expect, it } from "vitest";
import { withDriver, assertToolResultContainsText } from "../test/preamble.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { ToolName } from "./types.ts";

it("render the getFile tool.", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(
      `Try reading the file node/test/fixtures/poem.txt`,
    );
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
              filePath: "./node/test/fixtures/poem.txt" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      `✅ Finished reading file \`./node/test/fixtures/poem.txt\``,
    );
  });
});

it("getFile rejection", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(
      `Try reading the file node/test/fixtures/.secret`,
    );
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
              filePath: "node/test/fixtures/.secret" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`\
May I read file \`node/test/fixtures/.secret\`? **[ NO ]** **[ OK ]**`);
    const noPos = await driver.assertDisplayBufferContains("**[ NO ]**");

    await driver.triggerDisplayBufferKey(noPos, "<CR>");
    await driver.assertDisplayBufferContains(
      "❌ Error reading file `node/test/fixtures/.secret`: The user did not allow the reading of this file.",
    );
  });
});

it("getFile approval", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(
      `Try reading the file node/test/fixtures/.secret`,
    );
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
              filePath: "node/test/fixtures/.secret" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`\
May I read file \`node/test/fixtures/.secret\`? **[ NO ]** **[ OK ]**`);
    const okPos = await driver.assertDisplayBufferContains("**[ OK ]**");

    await driver.triggerDisplayBufferKey(okPos, "<CR>");
    await driver.assertDisplayBufferContains(`\
Finished reading file \`node/test/fixtures/.secret\``);
  });
});

it("getFile requests approval for gitignored file", async () => {
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
May I read file \`node_modules/test\`? **[ NO ]** **[ OK ]**`);
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
May I read file \`/tmp/file\`? **[ NO ]** **[ OK ]**`);
  });
});

it("getFile returns early when file is already in context", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Add the file to context first
    await driver.nvim.call("nvim_command", [
      `Magenta context-files './node/test/fixtures/poem.txt'`,
    ]);

    await driver.assertDisplayBufferContains("- `node/test/fixtures/poem.txt`");

    // Now try to read the same file without force
    await driver.inputMagentaText(
      `Try reading the file ./node/test/fixtures/poem.txt`,
    );
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
              filePath: "./node/test/fixtures/poem.txt" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    // Should return the early message about file already being in context
    await driver.assertDisplayBufferContains(
      `✅ Finished reading file \`./node/test/fixtures/poem.txt\``,
    );

    // Check the actual response content in the next request
    const toolResultRequest = await driver.mockAnthropic.awaitPendingRequest();
    const toolResultMessage =
      toolResultRequest.messages[toolResultRequest.messages.length - 1];

    if (
      toolResultMessage.role === "user" &&
      Array.isArray(toolResultMessage.content)
    ) {
      const toolResult = toolResultMessage.content[0];
      if (toolResult.type === "tool_result") {
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
    await driver.nvim.call("nvim_command", [
      `Magenta context-files './node/test/fixtures/poem.txt'`,
    ]);

    await driver.assertDisplayBufferContains("- `node/test/fixtures/poem.txt`");

    await driver.inputMagentaText(
      `Try reading the file ./node/test/fixtures/poem.txt with force`,
    );
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
              filePath: "./node/test/fixtures/poem.txt" as UnresolvedFilePath,
              force: true,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      `✅ Finished reading file \`./node/test/fixtures/poem.txt\``,
    );

    const toolResultRequest = await driver.mockAnthropic.awaitPendingRequest();
    const toolResultMessage =
      toolResultRequest.messages[toolResultRequest.messages.length - 1];

    if (
      toolResultMessage.role === "user" &&
      Array.isArray(toolResultMessage.content)
    ) {
      const toolResult = toolResultMessage.content[0];
      if (toolResult.type === "tool_result") {
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
    await driver.inputMagentaText(
      `Try reading the file ./node/test/fixtures/poem.txt`,
    );
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
              filePath: "./node/test/fixtures/poem.txt" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(
      `✅ Finished reading file \`./node/test/fixtures/poem.txt\``,
    );

    // Handle the auto-respond message
    const toolResultRequest = await driver.mockAnthropic.awaitPendingRequest();
    toolResultRequest.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I've successfully read the file.",
    });

    await driver.assertDisplayBufferContains("# context:");
    await driver.assertDisplayBufferContains("- `node/test/fixtures/poem.txt`");
  });
});
