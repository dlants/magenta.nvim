import type Anthropic from "@anthropic-ai/sdk";
import type {
  ToolName,
  ToolRequestId,
  UnresolvedFilePath,
} from "@magenta/server";
import { expect, it } from "vitest";
import type { BufNr } from "../nvim/buffer.ts";
import { MockProvider } from "../providers/mock.ts";
import { assertToolResultContainsText, withDriver } from "../test/preamble.ts";

type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
type TextBlockParam = Anthropic.Messages.TextBlockParam;

it("render the getFile tool.", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`Try reading the file poem.txt`);
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();
    request1.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "request_id" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: {
              files: [
                {
                  filePath: "./poem.txt" as UnresolvedFilePath,
                },
              ],
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains("✅ ");
  });
});

it("should expand get_file tool input on <CR>", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`Try reading the file poem.txt`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "request_id" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: {
              files: [
                {
                  filePath: "./poem.txt" as UnresolvedFilePath,
                },
              ],
            },
          },
        },
      ],
    });

    // Press = on the summary to expand input details
    await driver.triggerDisplayBufferKeyOnContent(`read 1 file`, "=");

    // Verify the JSON input is now visible (not file content, since get_file has no result detail)
    await driver.assertDisplayBufferContains('"filePath": "./poem.txt"');
  });
});

it("expands a file's sent content with = on its result line", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`Try reading the file poem.txt`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "request_id" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: {
              files: [{ filePath: "./poem.txt" as UnresolvedFilePath }],
            },
          },
        },
      ],
    });

    // The per-file result line shows a checkmark + token estimate.
    await driver.assertDisplayBufferContains("`poem.txt` (~");

    // Press = on the result line to expand the content as it was sent.
    await driver.triggerDisplayBufferKeyOnContent("`poem.txt` (~", "=");

    // The raw file content (not JSON-escaped) should now be visible.
    await driver.assertDisplayBufferContains(
      "Moonlight whispers through the trees,",
    );
  });
});

it("expands the correct file's content when reading multiple files", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`Read poem.txt and poem 3.txt`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "request_id" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: {
              files: [
                { filePath: "./poem.txt" as UnresolvedFilePath },
                { filePath: "./poem 3.txt" as UnresolvedFilePath },
              ],
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains("`poem 3.txt` (~");

    // Expanding the second file should show its content, not the first file's.
    await driver.triggerDisplayBufferKeyOnContent("`poem 3.txt` (~", "=");
    await driver.assertDisplayBufferContains("poem3");
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

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "ok, here goes",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "request_id" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: {
              files: [
                {
                  filePath: "./poem.txt" as UnresolvedFilePath,
                },
              ],
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains("✅ ");

    // Check that the file contents are properly returned
    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
    const toolResultMessage = MockProvider.findLastToolResultMessage(
      toolResultRequest.messages,
    );

    expect(toolResultMessage).toBeDefined();
    expect(toolResultMessage!.role).toBe("user");
    expect(Array.isArray(toolResultMessage!.content)).toBe(true);
    const contentArray = toolResultMessage!.content as ContentBlockParam[];

    const toolResult = contentArray.find(
      (item: ContentBlockParam) => item.type === "tool_result",
    ) as ToolResultBlockParam;
    expect(toolResult).toBeDefined();

    assertToolResultContainsText(
      toolResult,
      "Moonlight whispers through the trees",
    );

    // Verify the full content is returned, not empty content
    expect(toolResult.is_error).toBeFalsy();

    const toolResultContent = toolResult.content as ContentBlockParam[];
    const textContent = toolResultContent.find(
      (item: ContentBlockParam) =>
        item.type === "text" && !item.text.startsWith("==="),
    ) as TextBlockParam;
    expect(textContent).toBeDefined();

    // Should contain the full poem, not be empty
    expect(textContent.text.trim()).not.toBe("");
    expect(textContent.text).toContain("Moonlight whispers through the trees");
    expect(textContent.text).toContain("Silver shadows dance with ease");

    // Respond to complete the conversation
    toolResultRequest.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I've successfully read the file.",
    });
  });
});
