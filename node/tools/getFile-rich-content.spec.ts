import type { ToolRequestId } from "./toolManager.ts";
import { expect, it, describe } from "vitest";
import {
  withDriver,
  TMP_DIR,
  assertToolResultHasImageSource,
  assertToolResultHasDocumentSource,
} from "../test/preamble.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { ToolName } from "./types.ts";

describe("getFile rich content integration tests", () => {
  it("should process image files end-to-end", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Request to read an image file
      await driver.inputMagentaText(
        `Please analyze the image in node/test/fixtures/test.jpg`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "I'll analyze the image for you",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "img_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "./node/test/fixtures/test.jpg" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      // Should show successful processing
      await driver.assertDisplayBufferContains(
        `✅ Finished reading file \`./node/test/fixtures/test.jpg\``,
      );

      // Verify the tool result contains image content
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      const toolResultMessage =
        toolResultRequest.messages[toolResultRequest.messages.length - 1];

      if (
        toolResultMessage.role === "user" &&
        Array.isArray(toolResultMessage.content)
      ) {
        const toolResult = toolResultMessage.content[0];
        if (toolResult.type === "tool_result") {
          expect(toolResult.result.status).toBe("ok");

          // The result should be image content, not text
          if (toolResult.result.status === "ok") {
            assertToolResultHasImageSource(toolResult, "image/jpeg");
          }
        }
      }

      // Complete the conversation
      toolResultRequest.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I can see the image content. It appears to be a test image file.",
      });
    });
  });

  it("should process PDF documents end-to-end", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Request to read a PDF file
      await driver.inputMagentaText(
        `Please read and analyze the PDF document in node/test/fixtures/test.pdf`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "I'll read the PDF document for you",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "pdf_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "./node/test/fixtures/test.pdf" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      // Should show successful processing
      await driver.assertDisplayBufferContains(
        `✅ Finished reading file \`./node/test/fixtures/test.pdf\``,
      );

      // Verify the tool result contains document content
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      const toolResultMessage =
        toolResultRequest.messages[toolResultRequest.messages.length - 1];

      if (
        toolResultMessage.role === "user" &&
        Array.isArray(toolResultMessage.content)
      ) {
        const toolResult = toolResultMessage.content[0];
        if (toolResult.type === "tool_result") {
          expect(toolResult.result.status).toBe("ok");

          // The result should be document content, not text
          if (toolResult.result.status === "ok") {
            assertToolResultHasDocumentSource(toolResult, "application/pdf");
          }
        }
      }

      // Complete the conversation
      toolResultRequest.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've successfully processed the PDF document.",
      });
    });
  });

  it("should reject binary files that are not supported", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Request to read an unsupported binary file
      await driver.inputMagentaText(
        `Please read the file node/test/fixtures/test.bin`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "I'll try to read the binary file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "bin_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "./node/test/fixtures/test.bin" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      // Should show error for unsupported file type
      await driver.assertDisplayBufferContains(
        `❌ Error reading file \`./node/test/fixtures/test.bin\`: Unsupported file type`,
      );

      // Verify the tool result contains error
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      const toolResultMessage =
        toolResultRequest.messages[toolResultRequest.messages.length - 1];

      if (
        toolResultMessage.role === "user" &&
        Array.isArray(toolResultMessage.content)
      ) {
        const toolResult = toolResultMessage.content[0];
        if (toolResult.type === "tool_result") {
          expect(toolResult.result.status).toBe("error");

          if (toolResult.result.status === "error") {
            expect(toolResult.result.error).toContain("Unsupported file type");
          }
        }
      }
    });
  });

  it("should not add images to context manager", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Verify context is empty initially
      expect(
        driver.magenta.chat.getActiveThread().contextManager.files,
      ).toEqual({});

      // Read an image file
      await driver.inputMagentaText(
        `Please analyze node/test/fixtures/test.jpg`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
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
                filePath: "./node/test/fixtures/test.jpg" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(
        `✅ Finished reading file \`./node/test/fixtures/test.jpg\``,
      );

      // Handle the auto-respond message
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      toolResultRequest.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've analyzed the image successfully.",
      });

      // Context should still be empty (images not added to context)
      expect(
        driver.magenta.chat.getActiveThread().contextManager.files,
      ).toEqual({});

      // Context section should not be shown since no files were added
      const displayText = await driver.getDisplayBufferText();
      expect(displayText).not.toContain("# context:");
    });
  });

  it("should not add PDFs to context manager", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Verify context is empty initially
      expect(
        driver.magenta.chat.getActiveThread().contextManager.files,
      ).toEqual({});

      // Read a PDF file
      await driver.inputMagentaText(`Please read node/test/fixtures/test.pdf`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "I'll read the PDF",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "pdf_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "./node/test/fixtures/test.pdf" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(
        `✅ Finished reading file \`./node/test/fixtures/test.pdf\``,
      );

      // Handle the auto-respond message
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      toolResultRequest.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've read the PDF document successfully.",
      });

      // Context should still be empty (PDFs not added to context)
      expect(
        driver.magenta.chat.getActiveThread().contextManager.files,
      ).toEqual({});

      // Context section should not be shown since no files were added
      const displayText = await driver.getDisplayBufferText();
      expect(displayText).not.toContain("# context:");
    });
  });

  it("should continue to add text files to context normally", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Read a text file
      await driver.inputMagentaText(`Please read node/test/fixtures/poem.txt`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      request.respond({
        stopReason: "tool_use",
        text: "I'll read the text file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "text_request" as ToolRequestId,
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
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      toolResultRequest.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've read the text file successfully.",
      });

      // Text file should be added to context normally
      await driver.assertDisplayBufferContains("# context:");
      await driver.assertDisplayBufferContains(
        "- `node/test/fixtures/poem.txt`",
      );

      const relativeFiles = Object.values(
        driver.magenta.chat.getActiveThread().contextManager.files,
      ).map((f) => f.relFilePath);
      expect(relativeFiles).toContain("node/test/fixtures/poem.txt");
    });
  });

  it("should handle mixed content types in a single conversation", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Read the text file first
      await driver.inputMagentaText(
        `Please read the poem.txt file from the fixtures directory`,
      );
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingRequest();
      request1.respond({
        stopReason: "tool_use",
        text: "I'll read the text file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "text_request" as ToolRequestId,
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

      // Handle first auto-respond message
      const toolResultRequest1 =
        await driver.mockAnthropic.awaitPendingRequest();
      toolResultRequest1.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've read the text file. Now let me read the images.",
      });

      // Read the image file
      await driver.inputMagentaText(`Now please analyze the test.jpg image`);
      await driver.send();

      const request2 = await driver.mockAnthropic.awaitPendingRequest();
      request2.respond({
        stopReason: "tool_use",
        text: "I'll analyze the image",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "img_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "./node/test/fixtures/test.jpg" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(
        `✅ Finished reading file \`./node/test/fixtures/test.jpg\``,
      );

      // Handle second auto-respond message
      const toolResultRequest2 =
        await driver.mockAnthropic.awaitPendingRequest();
      toolResultRequest2.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've analyzed the image. Now let me read the PDF.",
      });

      // Read the PDF file
      await driver.inputMagentaText(
        `Finally, please read the test.pdf document`,
      );
      await driver.send();

      const request3 = await driver.mockAnthropic.awaitPendingRequest();
      request3.respond({
        stopReason: "tool_use",
        text: "I'll read the PDF",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "pdf_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "./node/test/fixtures/test.pdf" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(
        `✅ Finished reading file \`./node/test/fixtures/test.pdf\``,
      );

      // Handle final auto-respond message
      const toolResultRequest3 =
        await driver.mockAnthropic.awaitPendingRequest();
      toolResultRequest3.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've successfully processed all three files with different content types.",
      });

      // Only text file should be in context
      await driver.assertDisplayBufferContains("# context:");
      await driver.assertDisplayBufferContains(
        "- `node/test/fixtures/poem.txt`",
      );

      const relativeFiles = Object.values(
        driver.magenta.chat.getActiveThread().contextManager.files,
      ).map((f) => f.relFilePath);
      expect(relativeFiles).toEqual(["node/test/fixtures/poem.txt"]);
    });
  });

  it("should handle file size limits appropriately", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          // Create a large fake image file (we'll simulate this by creating content > 10MB)
          const { writeFile } = await import("node:fs/promises");
          const largeFakeImage = Buffer.alloc(11 * 1024 * 1024); // 11MB
          await writeFile(`${tmpDir}/large-image.jpg`, largeFakeImage);
        },
      },
      async (driver) => {
        await driver.showSidebar();

        // Request to read a large image file from the fixtures directory (copying it there)
        // First, copy the large file to fixtures to avoid approval issues
        const { copyFile } = await import("node:fs/promises");
        const fixturesDir = "node/test/fixtures";
        await copyFile(
          `${TMP_DIR}/large-image.jpg`,
          `${fixturesDir}/large-image.jpg`,
        );

        await driver.inputMagentaText(
          `Please analyze the large image in node/test/fixtures/large-image.jpg`,
        );
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingRequest();
        request.respond({
          stopReason: "tool_use",
          text: "I'll try to analyze the large image",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "large_img_request" as ToolRequestId,
                toolName: "get_file" as ToolName,
                input: {
                  filePath:
                    "./node/test/fixtures/large-image.jpg" as UnresolvedFilePath,
                },
              },
            },
          ],
        });

        // Should show error for file too large
        await driver.assertDisplayBufferContains(
          `❌ Error reading file \`./node/test/fixtures/large-image.jpg\`: File too large`,
        );

        // Verify the tool result contains error
        const toolResultRequest =
          await driver.mockAnthropic.awaitPendingRequest();
        const toolResultMessage =
          toolResultRequest.messages[toolResultRequest.messages.length - 1];

        if (
          toolResultMessage.role === "user" &&
          Array.isArray(toolResultMessage.content)
        ) {
          const toolResult = toolResultMessage.content[0];
          if (toolResult.type === "tool_result") {
            expect(toolResult.result.status).toBe("error");

            if (toolResult.result.status === "error") {
              expect(toolResult.result.error).toContain("File too large");
            }
          }
        }

        // Clean up the copied file
        const { unlink } = await import("node:fs/promises");
        try {
          await unlink("node/test/fixtures/large-image.jpg");
        } catch {
          // Ignore cleanup errors
        }
      },
    );
  });
});
