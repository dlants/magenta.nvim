import type Anthropic from "@anthropic-ai/sdk";
import type {
  ToolName,
  ToolRequestId,
  UnresolvedFilePath,
} from "@magenta/core";
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
    await driver.triggerDisplayBufferKeyOnContent(`\`poem.txt\``, "=");

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

    // Handle the auto-respond message
    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
    toolResultRequest.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I've successfully read the file.",
    });

    const relativeFiles = Object.values(
      driver.magenta.chat.getActiveThread().contextManager.files,
    ).map((f) => f.relFilePath);
    expect(relativeFiles).toContain("poem.txt");
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

it("should add images to context manager", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Verify context is empty initially
    expect(driver.magenta.chat.getActiveThread().contextManager.files).toEqual(
      {},
    );

    // Read an image file
    await driver.inputMagentaText(`Please analyze test.jpg`);
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
            toolName: "get_files" as ToolName,
            input: {
              files: [
                {
                  filePath: "test.jpg" as UnresolvedFilePath,
                },
              ],
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains("`test.jpg`");

    // Handle the auto-respond message
    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
    toolResultRequest.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I've analyzed the image successfully.",
    });

    // Wait for the conversation to complete (animation should stop)
    await driver.assertDisplayBufferDoesNotContain("Streaming response");

    // Context should contain the image
    const contextFiles =
      driver.magenta.chat.getActiveThread().contextManager.files;
    expect(Object.keys(contextFiles)).toHaveLength(1);
    const fileEntry = Object.values(contextFiles)[0];
    expect(fileEntry.relFilePath).toBe("test.jpg");
    expect(fileEntry.fileTypeInfo.category).toBe("image");
  });
});

it("should add PDFs to context manager", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Verify context is empty initially
    expect(driver.magenta.chat.getActiveThread().contextManager.files).toEqual(
      {},
    );

    // Read a PDF file
    await driver.inputMagentaText(`Please read sample2.pdf`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "I'll read the PDF",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "pdf_request" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: {
              files: [
                {
                  filePath: "sample2.pdf" as UnresolvedFilePath,
                },
              ],
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains("`sample2.pdf`");

    // Handle the auto-respond message
    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
    toolResultRequest.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I've read the PDF document successfully.",
    });

    // Wait for the conversation to complete (animation should stop)
    await driver.assertDisplayBufferDoesNotContain("Streaming response");

    // Context should contain the PDF
    const contextFiles =
      driver.magenta.chat.getActiveThread().contextManager.files;
    expect(Object.keys(contextFiles)).toHaveLength(1);
    const fileEntry = Object.values(contextFiles)[0];
    expect(fileEntry.relFilePath).toBe("sample2.pdf");
    expect(fileEntry.fileTypeInfo.category).toBe("pdf");
  });
});

it("should continue to add text files to context normally", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Read a text file
    await driver.inputMagentaText(`Please read poem.txt`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "I'll read the text file",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "text_request" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: {
              files: [
                {
                  filePath: "poem.txt" as UnresolvedFilePath,
                },
              ],
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains("✅ ");

    // Handle the auto-respond message
    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
    toolResultRequest.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I've read the text file successfully.",
    });

    const relativeFiles = Object.values(
      driver.magenta.chat.getActiveThread().contextManager.files,
    ).map((f) => f.relFilePath);
    expect(relativeFiles).toContain("poem.txt");
  });
});

it("should handle mixed content types in a single conversation", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Read the text file first
    await driver.inputMagentaText(`Please read the poem.txt file`);
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();
    request1.respond({
      stopReason: "tool_use",
      text: "I'll read the text file",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "text_request" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: {
              files: [
                {
                  filePath: "poem.txt" as UnresolvedFilePath,
                },
              ],
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains("✅ ");

    // Handle first auto-respond message
    const toolResultRequest1 = await driver.mockAnthropic.awaitPendingStream();
    toolResultRequest1.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I've read the text file. Now let me read the images.",
    });

    // Read the image file
    await driver.inputMagentaText(`Now please analyze the test.jpg image`);
    await driver.send();

    const request2 = await driver.mockAnthropic.awaitPendingStream();
    request2.respond({
      stopReason: "tool_use",
      text: "I'll analyze the image",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "img_request" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: {
              files: [
                {
                  filePath: "test.jpg" as UnresolvedFilePath,
                },
              ],
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains("`test.jpg`");

    // Handle second auto-respond message
    const toolResultRequest2 = await driver.mockAnthropic.awaitPendingStream();
    toolResultRequest2.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I've analyzed the image. Now let me read the PDF.",
    });

    // Read the PDF file
    await driver.inputMagentaText(
      `Finally, please read the sample2.pdf document`,
    );
    await driver.send();

    const request3 = await driver.mockAnthropic.awaitPendingStream();
    request3.respond({
      stopReason: "tool_use",
      text: "I'll read the PDF",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "pdf_request" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: {
              files: [
                {
                  filePath: "sample2.pdf" as UnresolvedFilePath,
                },
              ],
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains("`sample2.pdf`");

    // Handle final auto-respond message
    const toolResultRequest3 = await driver.mockAnthropic.awaitPendingStream();
    toolResultRequest3.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I've successfully processed all three files with different content types.",
    });

    // All files should be in context

    const relativeFiles = Object.values(
      driver.magenta.chat.getActiveThread().contextManager.files,
    )
      .map((f) => f.relFilePath)
      .sort();
    expect(relativeFiles).toEqual(["poem.txt", "sample2.pdf", "test.jpg"]);
  });
});
