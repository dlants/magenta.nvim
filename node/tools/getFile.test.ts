import type { ToolRequestId } from "./toolManager.ts";
import { expect, it } from "vitest";
import {
  withDriver,
  assertToolResultContainsText,
  assertToolResultHasImageSource,
} from "../test/preamble.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { ToolName } from "./types.ts";
import type { BufNr } from "../nvim/buffer.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { MockProvider } from "../providers/mock.ts";

type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
type TextBlockParam = Anthropic.Messages.TextBlockParam;
type DocumentBlockParam = Anthropic.Messages.DocumentBlockParam;

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
            toolName: "get_file" as ToolName,
            input: {
              filePath: "./poem.txt" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`poem.txt\``);
  });
});

it("should expand get_file tool detail on <CR>", async () => {
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
            toolName: "get_file" as ToolName,
            input: {
              filePath: "./poem.txt" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    // Verify summary is shown
    const summaryPos =
      await driver.assertDisplayBufferContains(`👀✅ \`poem.txt\``);

    // Press <CR> on the summary to expand details
    await driver.triggerDisplayBufferKey(summaryPos, "<CR>");

    // Verify the file content is now visible (poem.txt content from fixtures)
    await driver.assertDisplayBufferContains(
      "Moonlight whispers through the trees",
    );
  });
});

it("should extract PDF page as binary document when pdfPage parameter is provided", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        // Create a multi-page PDF for testing
        const { PDFDocument } = await import("pdf-lib");
        const pdfDoc = await PDFDocument.create();

        const page1 = pdfDoc.addPage([600, 400]);
        page1.drawText("First Page Content", { x: 50, y: 350 });

        const page2 = pdfDoc.addPage([600, 400]);
        page2.drawText("Second Page Content", { x: 50, y: 350 });

        const pdfBytes = await pdfDoc.save();
        const fs = await import("fs/promises");
        const path = await import("path");
        const testPdfPath = path.join(tmpDir, "multipage.pdf");
        await fs.writeFile(testPdfPath, pdfBytes);
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Request to extract a specific page from PDF
      await driver.inputMagentaText(`Please read page 2 of multipage.pdf`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll extract the specific page from the PDF",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "pdf_page_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "multipage.pdf" as UnresolvedFilePath,
                pdfPage: 2,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`multipage.pdf`);

      // Verify the tool result contains document content
      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      // Find the user message with the tool result - documents are sibling blocks, not nested
      let userMessageContent: ContentBlockParam[] | undefined;
      for (const msg of toolResultRequest.messages) {
        if (msg.role === "user" && Array.isArray(msg.content)) {
          const content = msg.content;
          const hasToolResult = content.some(
            (block: ContentBlockParam) =>
              block.type === "tool_result" &&
              block.tool_use_id === "pdf_page_request",
          );
          if (hasToolResult) userMessageContent = content;
        }
      }
      expect(userMessageContent).toBeDefined();
      if (!userMessageContent)
        throw new Error("No user message with tool result found");

      // Tool result should not have error
      const toolResult = userMessageContent.find(
        (block: ContentBlockParam) => block.type === "tool_result",
      ) as ToolResultBlockParam;
      expect(toolResult.is_error).toBeFalsy();

      // Document is a sibling block in the user message, not nested in tool_result.content
      const documentContent = userMessageContent.find(
        (item: ContentBlockParam) => item.type === "document",
      ) as DocumentBlockParam;
      expect(documentContent).toBeDefined();

      expect(documentContent.source.type).toBe("base64");
      if (documentContent.source.type !== "base64")
        throw new Error("Expected base64 source");
      expect(documentContent.source.media_type).toBe("application/pdf");
      expect(documentContent.source.data).toBeTruthy();
      expect(documentContent.title).toContain("multipage.pdf - Page 2");

      // Complete the conversation to ensure context is updated
      toolResultRequest.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've extracted the PDF page successfully.",
      });

      // Verify the PDF appears in context with page information
      await driver.assertDisplayBufferContains("# context:");
      await driver.assertDisplayBufferContains(
        "- `multipage.pdf` (summary, page 2)",
      );

      // Verify the context manager has the correct PDF page information
      const contextManager =
        driver.magenta.chat.getActiveThread().context.contextManager;
      const contextFiles = contextManager.files;
      expect(Object.keys(contextFiles)).toHaveLength(1);

      const fileEntry = Object.values(contextFiles)[0];
      expect(fileEntry.relFilePath).toBe("multipage.pdf");
      expect(fileEntry.fileTypeInfo.category).toBe("pdf");
      expect(fileEntry.agentView?.type).toBe("pdf");
      if (fileEntry.agentView?.type === "pdf") {
        expect(fileEntry.agentView.pages).toEqual([2]);
        expect(fileEntry.agentView.summary).toBe(true);
      }
    },
  );
});

it("should handle multiple PDF pages and show correct context summary", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        // Create a multi-page PDF for testing
        const { PDFDocument } = await import("pdf-lib");
        const pdfDoc = await PDFDocument.create();

        // Add 5 pages to test page ranges
        for (let i = 1; i <= 5; i++) {
          const page = pdfDoc.addPage([600, 400]);
          page.drawText(`Page ${i} Content`, { x: 50, y: 350 });
        }

        const pdfBytes = await pdfDoc.save();
        const fs = await import("fs/promises");
        const path = await import("path");
        const testPdfPath = path.join(tmpDir, "multipage-test.pdf");
        await fs.writeFile(testPdfPath, pdfBytes);
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // First, get the summary
      await driver.inputMagentaText(`Please read multipage-test.pdf`);
      await driver.send();

      const summaryRequest = await driver.mockAnthropic.awaitPendingStream();
      summaryRequest.respond({
        stopReason: "tool_use",
        text: "I'll read the PDF summary",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "pdf_summary_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "multipage-test.pdf" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`multipage-test.pdf\``);

      const summaryToolResult = await driver.mockAnthropic.awaitPendingStream();
      summaryToolResult.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've read the PDF summary. Now let me get specific pages.",
      });

      // Verify context shows summary
      await driver.assertDisplayBufferContains(
        "- `multipage-test.pdf` (summary)",
      );

      // Now request page 1
      await driver.inputMagentaText(`Please read page 1 of multipage-test.pdf`);
      await driver.send();

      const page1Request = await driver.mockAnthropic.awaitPendingStream();
      page1Request.respond({
        stopReason: "tool_use",
        text: "I'll extract page 1",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "pdf_page1_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "multipage-test.pdf" as UnresolvedFilePath,
                pdfPage: 1,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`multipage-test.pdf`);

      const page1ToolResult = await driver.mockAnthropic.awaitPendingStream();
      page1ToolResult.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "Got page 1. Now getting page 3.",
      });

      // Verify context shows summary + page 1
      await driver.assertDisplayBufferContains(
        "- `multipage-test.pdf` (summary, page 1)",
      );

      // Now request page 3 (non-contiguous)
      await driver.inputMagentaText(`Please read page 3 of multipage-test.pdf`);
      await driver.send();

      const page3Request = await driver.mockAnthropic.awaitPendingStream();
      page3Request.respond({
        stopReason: "tool_use",
        text: "I'll extract page 3",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "pdf_page3_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "multipage-test.pdf" as UnresolvedFilePath,
                pdfPage: 3,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`multipage-test.pdf`);

      const page3ToolResult = await driver.mockAnthropic.awaitPendingStream();
      page3ToolResult.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "Got page 3. Now getting page 2.",
      });

      // Verify context shows summary + pages 1, 3
      await driver.assertDisplayBufferContains(
        "- `multipage-test.pdf` (summary, pages 1, 3)",
      );

      // Now request page 2 (to create a contiguous range 1-3)
      await driver.inputMagentaText(`Please read page 2 of multipage-test.pdf`);
      await driver.send();

      const page2Request = await driver.mockAnthropic.awaitPendingStream();
      page2Request.respond({
        stopReason: "tool_use",
        text: "I'll extract page 2",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "pdf_page2_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "multipage-test.pdf" as UnresolvedFilePath,
                pdfPage: 2,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`multipage-test.pdf`);

      const page2ToolResult = await driver.mockAnthropic.awaitPendingStream();
      page2ToolResult.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "Got page 2. Now getting page 5.",
      });

      // Verify context shows summary + pages 1-3 (as a range)
      await driver.assertDisplayBufferContains(
        "- `multipage-test.pdf` (summary, pages 1-3)",
      );

      // Finally request page 5 (non-contiguous again)
      await driver.inputMagentaText(`Please read page 5 of multipage-test.pdf`);
      await driver.send();

      const page5Request = await driver.mockAnthropic.awaitPendingStream();
      page5Request.respond({
        stopReason: "tool_use",
        text: "I'll extract page 5",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "pdf_page5_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "multipage-test.pdf" as UnresolvedFilePath,
                pdfPage: 5,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`multipage-test.pdf`);

      const page5ToolResult = await driver.mockAnthropic.awaitPendingStream();
      page5ToolResult.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "Got all the pages I need.",
      });

      // Verify final context shows summary + pages 1-3, 5
      await driver.assertDisplayBufferContains(
        "- `multipage-test.pdf` (summary, pages 1-3, 5)",
      );

      // Verify the context manager internal state
      const contextManager =
        driver.magenta.chat.getActiveThread().context.contextManager;
      const contextFiles = contextManager.files;
      expect(Object.keys(contextFiles)).toHaveLength(1);

      const fileEntry = Object.values(contextFiles)[0];
      expect(fileEntry.relFilePath).toBe("multipage-test.pdf");
      expect(fileEntry.fileTypeInfo.category).toBe("pdf");
      expect(fileEntry.agentView?.type).toBe("pdf");
      if (fileEntry.agentView?.type === "pdf") {
        expect(fileEntry.agentView.pages).toEqual([1, 2, 3, 5]); // Should be sorted
        expect(fileEntry.agentView.summary).toBe(true);
      }
    },
  );
});

it("should return PDF basic info when pdfPage parameter is not provided", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        // Create a multi-page PDF for testing
        const { PDFDocument } = await import("pdf-lib");
        const pdfDoc = await PDFDocument.create();

        const page1 = pdfDoc.addPage([600, 400]);
        page1.drawText("First Page Content", { x: 50, y: 350 });

        const page2 = pdfDoc.addPage([600, 400]);
        page2.drawText("Second Page Content", { x: 50, y: 350 });

        const page3 = pdfDoc.addPage([600, 400]);
        page3.drawText("Third Page Content", { x: 50, y: 350 });

        const pdfBytes = await pdfDoc.save();
        const fs = await import("fs/promises");
        const path = await import("path");
        const testPdfPath = path.join(tmpDir, "multipage.pdf");
        await fs.writeFile(testPdfPath, pdfBytes);
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Request to read PDF without pdfPage parameter
      await driver.inputMagentaText(`Please read multipage.pdf`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll read the PDF document",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "pdf_basic_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "multipage.pdf" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`multipage.pdf`);

      // Verify the tool result contains basic PDF info
      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        toolResultRequest.messages,
      );

      expect(toolResultMessage).toBeDefined();
      expect(toolResultMessage!.role).toBe("user");
      expect(Array.isArray(toolResultMessage!.content)).toBe(true);
      const contentArray = toolResultMessage!.content as ContentBlockParam[];

      const toolResult = contentArray[0] as ToolResultBlockParam;
      expect(toolResult.type).toBe("tool_result");
      expect(toolResult.is_error).toBeFalsy();

      const toolResultContent = toolResult.content as ContentBlockParam[];
      const textContent = toolResultContent.find(
        (item: ContentBlockParam) => item.type === "text",
      ) as TextBlockParam;
      expect(textContent).toBeDefined();
      expect(textContent.text).toContain("PDF Document:");
      expect(textContent.text).toContain("multipage.pdf");
      expect(textContent.text).toContain("Pages: 3");
      expect(textContent.text).toContain(
        "Use get-file tool with a pdfPage parameter to access specific pages",
      );
    },
  );
});

it("should handle invalid PDF page index", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        // Create a single-page PDF for testing
        const { PDFDocument } = await import("pdf-lib");
        const pdfDoc = await PDFDocument.create();

        const page1 = pdfDoc.addPage([600, 400]);
        page1.drawText("Only Page Content", { x: 50, y: 350 });

        const pdfBytes = await pdfDoc.save();
        const fs = await import("fs/promises");
        const path = await import("path");
        const testPdfPath = path.join(tmpDir, "singlepage.pdf");
        await fs.writeFile(testPdfPath, pdfBytes);
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Request to extract an invalid page from PDF
      await driver.inputMagentaText(`Please read page 5 of singlepage.pdf`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll try to extract page 5 from the PDF",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "pdf_invalid_page_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "singlepage.pdf" as UnresolvedFilePath,
                pdfPage: 5,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀❌ \`singlepage.pdf`);

      // Verify the tool result contains error
      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        toolResultRequest.messages,
      );

      expect(toolResultMessage).toBeDefined();
      expect(toolResultMessage!.role).toBe("user");
      expect(Array.isArray(toolResultMessage!.content)).toBe(true);
      const contentArray = toolResultMessage!.content as ContentBlockParam[];

      const toolResult = contentArray[0] as ToolResultBlockParam;
      expect(toolResult.type).toBe("tool_result");
      expect(toolResult.is_error).toBe(true);

      const errorContent =
        typeof toolResult.content === "string"
          ? toolResult.content
          : JSON.stringify(toolResult.content);
      expect(errorContent).toContain("Page index 5 is out of range");
      expect(errorContent).toContain("Document has 1 pages");
    },
  );
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

      const request = await driver.mockAnthropic.awaitPendingStream();
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

      const request1 = await driver.mockAnthropic.awaitPendingStream();
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
        await driver.mockAnthropic.awaitPendingStream();
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

      const request2 = await driver.mockAnthropic.awaitPendingStream();
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

      const request = await driver.mockAnthropic.awaitPendingStream();
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

it("getFile automatically allows files in skills directory", async () => {
  await withDriver(
    {
      options: {
        skillsPaths: [".claude/skills"],
      },
      setupFiles: async (tmpDir) => {
        const fs = await import("fs/promises");
        const path = await import("path");

        // Create skills directory structure
        await fs.mkdir(path.join(tmpDir, ".claude/skills/my-skill"), {
          recursive: true,
        });
        await fs.writeFile(
          path.join(tmpDir, ".claude/skills/my-skill/skill.md"),
          "---\nname: my-skill\ndescription: A test skill\n---\n\n# Skill content",
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Test that files in skills directory are automatically allowed
      await driver.inputMagentaText(
        `Try reading the file .claude/skills/my-skill/skill.md`,
      );
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
              toolName: "get_file" as ToolName,
              input: {
                filePath:
                  ".claude/skills/my-skill/skill.md" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      // Should be automatically approved, not show approval dialog
      await driver.assertDisplayBufferContains(
        `👀✅ \`.claude/skills/my-skill/skill.md\``,
      );

      // Verify the file contents are returned
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

      assertToolResultContainsText(toolResult, "Skill content");
    },
  );
});

it("getFile rejection", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`Try reading the file .secret`);
    await driver.send();

    const request2 = await driver.mockAnthropic.awaitPendingStream();
    request2.respond({
      stopReason: "tool_use",
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
    const noPos = await driver.assertDisplayBufferContains("> NO");

    await driver.triggerDisplayBufferKey(noPos, "<CR>");
    await driver.assertDisplayBufferContains("👀❌ `.secret`");
  });
});

it("displays approval dialog with proper box formatting", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`Try reading the file .secret`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
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

    // Verify the vertical button layout is displayed correctly
    await driver.assertDisplayBufferContains("> NO");
    await driver.assertDisplayBufferContains("> YES");

    // Test that clicking YES works
    const yesPos = await driver.assertDisplayBufferContains("> YES");
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

    const request3 = await driver.mockAnthropic.awaitPendingStream();
    request3.respond({
      stopReason: "tool_use",
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
    const okPos = await driver.assertDisplayBufferContains("> YES");

    await driver.triggerDisplayBufferKey(okPos, "<CR>");
    await driver.assertDisplayBufferContains(`\
👀✅ \`.secret\``);
  });
});

it("getFile requests approval for file outside cwd", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`Try reading the file /tmp/file`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
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

    const request = await driver.mockAnthropic.awaitPendingStream();
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
    await driver.assertDisplayBufferContains(`👀✅ \`poem.txt\``);

    // Check the actual response content in the next request
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
      "already part of the thread context",
    );
  });
});

it("getFile reads file when force is true even if already in context", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Add the file to context first
    await driver.addContextFiles("./poem.txt");

    await driver.inputMagentaText(`Try reading the file ./poem.txt with force`);
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
            toolName: "get_file" as ToolName,
            input: {
              filePath: "./poem.txt" as UnresolvedFilePath,
              force: true,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`poem.txt\``);

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

    // Verify that the "already part of the thread context" message is NOT present
    expect(toolResult.is_error).toBeFalsy();
    const toolResultContent = toolResult.content as ContentBlockParam[];
    const hasContextText = toolResultContent.some((item: ContentBlockParam) => {
      if (item.type === "text") {
        return item.text.includes("already part of the thread context");
      }
      return false;
    });
    expect(hasContextText).toBe(false);
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
            toolName: "get_file" as ToolName,
            input: {
              filePath: "./poem.txt" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`poem.txt\``);

    // Handle the auto-respond message
    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
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

    const request = await driver.mockAnthropic.awaitPendingStream();
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

    await driver.assertDisplayBufferContains(`👀✅ \`poem.txt\``);

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
      (item: ContentBlockParam) => item.type === "text",
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

it("should process image files end-to-end", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Request to read an image file
    await driver.inputMagentaText(`Please analyze the image in test.jpg`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
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
              filePath: "test.jpg" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    // Should show successful processing
    await driver.assertDisplayBufferContains(`👀✅ \`test.jpg\``);

    // Verify the tool result contains image content
    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
    const toolResultMessage = MockProvider.findLastToolResultMessage(
      toolResultRequest.messages,
    );

    expect(toolResultMessage).toBeDefined();
    expect(toolResultMessage!.role).toBe("user");
    expect(Array.isArray(toolResultMessage!.content)).toBe(true);
    const contentArray = toolResultMessage!.content as ContentBlockParam[];

    const toolResult = contentArray[0] as ToolResultBlockParam;
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.is_error).toBeFalsy();

    // The result should be image content, not text
    assertToolResultHasImageSource(toolResult, "image/jpeg");

    // Complete the conversation
    toolResultRequest.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I can see the image content. It appears to be a test image file.",
    });
  });
});

it("getFile provides PDF summary info when no pdfPage parameter is given", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`Try reading the PDF file sample2.pdf`);
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
            toolName: "get_file" as ToolName,
            input: {
              filePath: "sample2.pdf" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`sample2.pdf\``);

    // Check that the PDF summary is returned
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
    expect(toolResult.is_error).toBeFalsy();

    const toolResultContent = toolResult.content as ContentBlockParam[];
    const textContent = toolResultContent.find(
      (item: ContentBlockParam) => item.type === "text",
    ) as TextBlockParam;
    expect(textContent).toBeDefined();

    // Should contain PDF summary information (uses absolute path)
    expect(textContent.text).toContain("PDF Document:");
    expect(textContent.text).toContain("sample2.pdf");
    expect(textContent.text).toContain("Pages:");
    expect(textContent.text).toContain(
      "Use get-file tool with a pdfPage parameter to access specific pages",
    );

    // Handle the auto-respond message
    toolResultRequest.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I've successfully read the PDF summary.",
    });
  });
});

it("should reject binary files that are not supported", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Request to read an unsupported binary file
    await driver.inputMagentaText(`Please read the file test.bin`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
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
              filePath: "test.bin" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    // Should show error for unsupported file type
    await driver.assertDisplayBufferContains(`👀❌ \`test.bin\``);

    // Verify the tool result contains error
    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
    const toolResultMessage = MockProvider.findLastToolResultMessage(
      toolResultRequest.messages,
    );

    expect(toolResultMessage).toBeDefined();
    expect(toolResultMessage!.role).toBe("user");
    expect(Array.isArray(toolResultMessage!.content)).toBe(true);
    const contentArray = toolResultMessage!.content as ContentBlockParam[];

    const toolResult = contentArray[0] as ToolResultBlockParam;
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.is_error).toBe(true);

    const errorContent =
      typeof toolResult.content === "string"
        ? toolResult.content
        : JSON.stringify(toolResult.content);
    expect(errorContent).toContain("Unsupported file type");
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

    // Context section should be shown
    await driver.assertDisplayBufferContains("# context:");
    await driver.assertDisplayBufferContains("- `test.jpg`");
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
            toolName: "get_file" as ToolName,
            input: {
              filePath: "sample2.pdf" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`sample2.pdf\``);

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

    // Context section should be shown
    await driver.assertDisplayBufferContains("# context:");
    await driver.assertDisplayBufferContains("- `sample2.pdf`");
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
            toolName: "get_file" as ToolName,
            input: {
              filePath: "poem.txt" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`poem.txt\``);

    // Handle the auto-respond message
    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
    toolResultRequest.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I've read the text file successfully.",
    });

    // Text file should be added to context normally
    await driver.assertDisplayBufferContains("# context:");
    await driver.assertDisplayBufferContains("- `poem.txt`");

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
            toolName: "get_file" as ToolName,
            input: {
              filePath: "poem.txt" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`poem.txt\``);

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
            toolName: "get_file" as ToolName,
            input: {
              filePath: "test.jpg" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`test.jpg\``);

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
            toolName: "get_file" as ToolName,
            input: {
              filePath: "sample2.pdf" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`sample2.pdf\``);

    // Handle final auto-respond message
    const toolResultRequest3 = await driver.mockAnthropic.awaitPendingStream();
    toolResultRequest3.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I've successfully processed all three files with different content types.",
    });

    // All files should be in context
    await driver.assertDisplayBufferContains("# context:");
    await driver.assertDisplayBufferContains("- `poem.txt`");
    await driver.assertDisplayBufferContains("- `test.jpg`");
    await driver.assertDisplayBufferContains("- `sample2.pdf`");

    const relativeFiles = Object.values(
      driver.magenta.chat.getActiveThread().contextManager.files,
    )
      .map((f) => f.relFilePath)
      .sort();
    expect(relativeFiles).toEqual(["poem.txt", "sample2.pdf", "test.jpg"]);
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

      // The large image file should already be in the test cwd
      await driver.inputMagentaText(
        `Please analyze the large image in large-image.jpg`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
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
                filePath: "large-image.jpg" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      // Should show error for file too large
      await driver.assertDisplayBufferContains(`👀❌ \`large-image.jpg\``);

      // Verify the tool result contains error
      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        toolResultRequest.messages,
      );

      expect(toolResultMessage).toBeDefined();
      expect(toolResultMessage!.role).toBe("user");
      expect(Array.isArray(toolResultMessage!.content)).toBe(true);
      const contentArray = toolResultMessage!.content as ContentBlockParam[];

      const toolResult = contentArray[0] as ToolResultBlockParam;
      expect(toolResult.type).toBe("tool_result");
      expect(toolResult.is_error).toBe(true);

      const errorContent =
        typeof toolResult.content === "string"
          ? toolResult.content
          : JSON.stringify(toolResult.content);
      expect(errorContent).toContain("File too large");

      // No cleanup needed since the file is in the temporary test directory
    },
  );
});

it("large text files are truncated and skip context manager", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const { writeFile } = await import("node:fs/promises");
        // Create a file with many lines (more than would fit in token limit)
        // MAX_FILE_TOKENS = 10000, CHARACTERS_PER_TOKEN = 4, so max chars = 40000
        // Create a file with 1000 lines of 100 chars each = 100000 chars
        const lines = Array.from(
          { length: 1000 },
          (_, i) => `Line ${String(i + 1).padStart(4, "0")}: ${"x".repeat(90)}`,
        );
        await writeFile(`${tmpDir}/large-file.txt`, lines.join("\n"));
      },
    },
    async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText(`Please read large-file.txt`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll read the file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "large_file_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "large-file.txt" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`large-file.txt\``);

      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        toolResultRequest.messages,
      );

      expect(toolResultMessage).toBeDefined();
      expect(toolResultMessage!.role).toBe("user");
      const contentArray = toolResultMessage!.content as ContentBlockParam[];
      const toolResult = contentArray.find(
        (item: ContentBlockParam) => item.type === "tool_result",
      ) as ToolResultBlockParam;
      expect(toolResult.is_error).toBeFalsy();

      const toolResultContent = toolResult.content as ContentBlockParam[];
      const textContent = toolResultContent.find(
        (item: ContentBlockParam) => item.type === "text",
      ) as TextBlockParam;

      expect(textContent.text).toContain("[File summary:");

      toolResultRequest.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've read the truncated file.",
      });

      // File should NOT be added to context manager since it was truncated
      const contextFiles =
        driver.magenta.chat.getActiveThread().contextManager.files;
      expect(Object.keys(contextFiles)).toHaveLength(0);
    },
  );
});

it("lines that are too long are abridged and skip context manager", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const { writeFile } = await import("node:fs/promises");
        // Create a file with one very long line (> MAX_LINE_TOKENS * CHARACTERS_PER_TOKEN = 2000 chars)
        const longLine = "x".repeat(3000);
        const content = `Line 1: normal\nLine 2: ${longLine}\nLine 3: normal`;
        await writeFile(`${tmpDir}/long-line-file.txt`, content);
      },
    },
    async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText(`Please read long-line-file.txt`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll read the file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "long_line_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "long-line-file.txt" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(`👀✅ \`long-line-file.txt\``);

      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        toolResultRequest.messages,
      );

      expect(toolResultMessage).toBeDefined();
      const contentArray = toolResultMessage!.content as ContentBlockParam[];
      const toolResult = contentArray.find(
        (item: ContentBlockParam) => item.type === "tool_result",
      ) as ToolResultBlockParam;
      expect(toolResult.is_error).toBeFalsy();

      const toolResultContent = toolResult.content as ContentBlockParam[];
      const textContent = toolResultContent.find(
        (item: ContentBlockParam) => item.type === "text",
      ) as TextBlockParam;

      // Should indicate lines were abridged
      expect(textContent.text).toContain("(some lines abridged)");
      // Should have the abridging marker in the content
      expect(textContent.text).toContain("chars omitted");

      toolResultRequest.respond({
        stopReason: "end_turn",
        toolRequests: [],
        text: "I've read the file with abridged lines.",
      });

      // File should NOT be added to context manager since lines were abridged
      const contextFiles =
        driver.magenta.chat.getActiveThread().contextManager.files;
      expect(Object.keys(contextFiles)).toHaveLength(0);
    },
  );
});

it("startLine and numLines parameters work and skip context manager", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText(`Please read lines 2-3 of poem.txt`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "I'll read those specific lines",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "partial_request" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: "poem.txt" as UnresolvedFilePath,
              startLine: 2,
              numLines: 2,
            },
          },
        },
      ],
    });

    // Should show the line range in the display
    await driver.assertDisplayBufferContains(`👀✅ \`poem.txt\` (lines 2-3)`);

    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
    const toolResultMessage = MockProvider.findLastToolResultMessage(
      toolResultRequest.messages,
    );

    expect(toolResultMessage).toBeDefined();
    const contentArray = toolResultMessage!.content as ContentBlockParam[];
    const toolResult = contentArray.find(
      (item: ContentBlockParam) => item.type === "tool_result",
    ) as ToolResultBlockParam;
    expect(toolResult.is_error).toBeFalsy();

    const toolResultContent = toolResult.content as ContentBlockParam[];
    const textContent = toolResultContent.find(
      (item: ContentBlockParam) => item.type === "text",
    ) as TextBlockParam;

    // Should have line range header
    expect(textContent.text).toContain("[Lines 2-3 of");
    // Should contain line 2 content
    expect(textContent.text).toContain("Silver shadows dance with ease");
    // Should NOT contain line 1
    expect(textContent.text).not.toContain("Moonlight whispers");

    toolResultRequest.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I've read the specific lines.",
    });

    // File should NOT be added to context manager since we only read partial content
    const contextFiles =
      driver.magenta.chat.getActiveThread().contextManager.files;
    expect(Object.keys(contextFiles)).toHaveLength(0);
  });
});

it("startLine parameter alone works and skips context manager", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText(`Please read poem.txt from line 3`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "I'll read from that line",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "partial_request" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: "poem.txt" as UnresolvedFilePath,
              startLine: 3,
            },
          },
        },
      ],
    });

    // Should show the starting line in the display
    await driver.assertDisplayBufferContains(`👀✅ \`poem.txt\` (from line 3)`);

    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
    const toolResultMessage = MockProvider.findLastToolResultMessage(
      toolResultRequest.messages,
    );

    expect(toolResultMessage).toBeDefined();
    const contentArray = toolResultMessage!.content as ContentBlockParam[];
    const toolResult = contentArray.find(
      (item: ContentBlockParam) => item.type === "tool_result",
    ) as ToolResultBlockParam;
    expect(toolResult.is_error).toBeFalsy();

    const toolResultContent = toolResult.content as ContentBlockParam[];
    const textContent = toolResultContent.find(
      (item: ContentBlockParam) => item.type === "text",
    ) as TextBlockParam;

    // Should have line range header starting at line 3
    expect(textContent.text).toContain("[Lines 3-");
    // Should contain lines 3 and 4
    expect(textContent.text).toContain("Stars above like diamonds bright");
    expect(textContent.text).toContain("Paint their stories in the night");
    // Should NOT contain lines 1-2
    expect(textContent.text).not.toContain("Moonlight whispers");
    expect(textContent.text).not.toContain("Silver shadows");

    toolResultRequest.respond({
      stopReason: "end_turn",
      toolRequests: [],
      text: "I've read from the specified line.",
    });

    // File should NOT be added to context manager since we started from a non-zero line
    const contextFiles =
      driver.magenta.chat.getActiveThread().contextManager.files;
    expect(Object.keys(contextFiles)).toHaveLength(0);
  });
});

it("requesting line range from file already in context returns early without force", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Add the file to context first
    await driver.addContextFiles("./poem.txt");

    // Now try to read a specific range without force
    await driver.inputMagentaText(`Please read lines 2-3 of poem.txt`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "I'll read those lines",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "range_request" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: "poem.txt" as UnresolvedFilePath,
              startLine: 2,
              numLines: 2,
            },
          },
        },
      ],
    });

    // Should still show the line range (not early return)
    await driver.assertDisplayBufferContains(`👀✅ \`poem.txt\` (lines 2-3)`);

    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
    const toolResultMessage = MockProvider.findLastToolResultMessage(
      toolResultRequest.messages,
    );

    expect(toolResultMessage).toBeDefined();
    const contentArray = toolResultMessage!.content as ContentBlockParam[];
    const toolResult = contentArray.find(
      (item: ContentBlockParam) => item.type === "tool_result",
    ) as ToolResultBlockParam;

    const toolResultContent = toolResult.content as ContentBlockParam[];
    const textContent = toolResultContent.find(
      (item: ContentBlockParam) => item.type === "text",
    ) as TextBlockParam;

    // With line params, should return the actual content (not early return)
    expect(textContent.text).toContain("[Lines 2-3 of");
    expect(textContent.text).toContain("Silver shadows dance with ease");
  });
});

it("force parameter with line range returns just those lines", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Add the file to context first
    await driver.addContextFiles("./poem.txt");

    // Now try to read a specific range with force
    await driver.inputMagentaText(
      `Please read lines 2-3 of poem.txt with force`,
    );
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "I'll read those lines with force",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "force_range_request" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: "poem.txt" as UnresolvedFilePath,
              startLine: 2,
              numLines: 2,
              force: true,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`poem.txt\` (lines 2-3)`);

    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
    const toolResultMessage = MockProvider.findLastToolResultMessage(
      toolResultRequest.messages,
    );

    expect(toolResultMessage).toBeDefined();
    const contentArray = toolResultMessage!.content as ContentBlockParam[];
    const toolResult = contentArray.find(
      (item: ContentBlockParam) => item.type === "tool_result",
    ) as ToolResultBlockParam;
    expect(toolResult.is_error).toBeFalsy();

    const toolResultContent = toolResult.content as ContentBlockParam[];
    const textContent = toolResultContent.find(
      (item: ContentBlockParam) => item.type === "text",
    ) as TextBlockParam;
    // Should return actual content with line range header
    expect(textContent.text).toContain("[Lines 2-3 of");
    expect(textContent.text).toContain("Silver shadows dance with ease");
    // Should NOT contain the "already in context" message
    expect(textContent.text).not.toContain(
      "already part of the thread context",
    );
  });
});

it("invalid startLine beyond file length returns error", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText(`Please read poem.txt from line 100`);
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "tool_use",
      text: "I'll try to read from that line",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "invalid_start_request" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: {
              filePath: "poem.txt" as UnresolvedFilePath,
              startLine: 100,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀❌ \`poem.txt\``);

    const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
    const toolResultMessage = MockProvider.findLastToolResultMessage(
      toolResultRequest.messages,
    );

    expect(toolResultMessage).toBeDefined();
    const contentArray = toolResultMessage!.content as ContentBlockParam[];
    const toolResult = contentArray[0] as ToolResultBlockParam;
    expect(toolResult.is_error).toBe(true);

    const errorContent =
      typeof toolResult.content === "string"
        ? toolResult.content
        : JSON.stringify(toolResult.content);
    expect(errorContent).toContain("startLine 100 is beyond end of file");
  });
});

it("line ranges with long lines still get abridged", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const { writeFile } = await import("node:fs/promises");
        // Create a file with a very long line in the middle
        const longLine = "x".repeat(3000);
        const content = `Line 1: normal\nLine 2: ${longLine}\nLine 3: normal\nLine 4: also normal`;
        await writeFile(`${tmpDir}/long-line-range.txt`, content);
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Request a specific range that includes the long line
      await driver.inputMagentaText(
        `Please read lines 2-3 of long-line-range.txt`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll read those lines",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "range_long_line_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "long-line-range.txt" as UnresolvedFilePath,
                startLine: 2,
                numLines: 2,
              },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains(
        `👀✅ \`long-line-range.txt\` (lines 2-3)`,
      );

      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        toolResultRequest.messages,
      );

      expect(toolResultMessage).toBeDefined();
      const contentArray = toolResultMessage!.content as ContentBlockParam[];
      const toolResult = contentArray.find(
        (item: ContentBlockParam) => item.type === "tool_result",
      ) as ToolResultBlockParam;
      expect(toolResult.is_error).toBeFalsy();

      const toolResultContent = toolResult.content as ContentBlockParam[];
      const textContent = toolResultContent.find(
        (item: ContentBlockParam) => item.type === "text",
      ) as TextBlockParam;

      // Should indicate lines were abridged
      expect(textContent.text).toContain("(some lines abridged)");
      // Should have the abridging marker in the content
      expect(textContent.text).toContain("chars omitted");
      // Should still show line 3 content
      expect(textContent.text).toContain("Line 3: normal");
    },
  );
});

it("should show file summary for large TypeScript file", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const fs = await import("fs/promises");
        const path = await import("path");

        // Create a large TypeScript file (>40K chars)
        const lines: string[] = [];
        lines.push("interface User {");
        lines.push("  name: string;");
        lines.push("  age: number;");
        lines.push("}");
        lines.push("");

        // Add many function declarations to make file large
        for (let i = 0; i < 500; i++) {
          lines.push(`function processItem${i}(data: User): string {`);
          lines.push(
            `  const result = data.name + " is " + data.age + " years old";`,
          );
          lines.push(`  console.log("Processing item ${i}:", result);`);
          lines.push(`  return result;`);
          lines.push(`}`);
          lines.push("");
        }

        lines.push("class DataProcessor {");
        lines.push("  private items: User[] = [];");
        lines.push("");
        lines.push("  addItem(item: User): void {");
        lines.push("    this.items.push(item);");
        lines.push("  }");
        lines.push("}");

        await fs.writeFile(path.join(tmpDir, "large.ts"), lines.join("\n"));
      },
    },
    async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("Read the large.ts file");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "tool_use",
        text: "I'll read that file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "tool1" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: { filePath: "./large.ts" as UnresolvedFilePath },
            },
          },
        ],
      });

      // Wait for tool result
      const resultStream = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        resultStream.messages,
      );

      expect(toolResultMessage).toBeDefined();
      const contentArray = toolResultMessage!.content as ContentBlockParam[];
      const toolResult = contentArray.find(
        (item: ContentBlockParam) => item.type === "tool_result",
      ) as ToolResultBlockParam;
      expect(toolResult).toBeDefined();
      expect(toolResult.is_error).toBeFalsy();

      const toolResultContent = toolResult.content as ContentBlockParam[];
      const textContent = toolResultContent.find(
        (item: ContentBlockParam) => item.type === "text",
      ) as TextBlockParam;

      expect(textContent.text).toContain("[File summary:");
      expect(textContent.text).toContain("interface User");
      expect(textContent.text).toContain("class DataProcessor");
    },
  );
});

it("getFile respects filePermissions from ~/.magenta/options.json for external directories", async () => {
  let outsidePath: string;

  await withDriver(
    {
      setupExtraDirs: async (baseDir) => {
        const fs = await import("fs/promises");
        const path = await import("path");

        // Create a directory outside cwd with a test file
        outsidePath = path.join(baseDir, "external-data");
        await fs.mkdir(outsidePath, { recursive: true });
        await fs.writeFile(
          path.join(outsidePath, "allowed-file.txt"),
          "This file should be auto-allowed via filePermissions",
        );

        // Write ~/.magenta/options.json with filePermissions granting read access
        const homeDir = path.join(baseDir, "home");
        const magentaDir = path.join(homeDir, ".magenta");
        await fs.mkdir(magentaDir, { recursive: true });
        await fs.writeFile(
          path.join(magentaDir, "options.json"),
          JSON.stringify({
            filePermissions: [{ path: outsidePath, read: true }],
          }),
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Try to read a file from the external directory
      await driver.inputMagentaText(
        `Please read the file ${outsidePath}/allowed-file.txt`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll read that file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "external_file_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath:
                  `${outsidePath}/allowed-file.txt` as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      // Should be automatically approved (no user approval dialog)
      await driver.assertDisplayBufferContains(
        `👀✅ \`${outsidePath}/allowed-file.txt\``,
      );

      // Verify the file content was returned
      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        toolResultRequest.messages,
      );

      expect(toolResultMessage).toBeDefined();
      const contentArray = toolResultMessage!.content as ContentBlockParam[];
      const toolResult = contentArray.find(
        (item: ContentBlockParam) => item.type === "tool_result",
      ) as ToolResultBlockParam;
      expect(toolResult).toBeDefined();
      expect(toolResult.is_error).toBeFalsy();

      assertToolResultContainsText(
        toolResult,
        "This file should be auto-allowed via filePermissions",
      );
    },
  );
});

it("getFile requires approval for external directory without filePermissions", async () => {
  let outsidePath: string;

  await withDriver(
    {
      setupExtraDirs: async (baseDir) => {
        const fs = await import("fs/promises");
        const path = await import("path");

        // Create a directory outside cwd with a test file
        outsidePath = path.join(baseDir, "restricted-data");
        await fs.mkdir(outsidePath, { recursive: true });
        await fs.writeFile(
          path.join(outsidePath, "restricted-file.txt"),
          "This file should require user approval",
        );

        // Create empty ~/.magenta/options.json (no filePermissions for this dir)
        const homeDir = path.join(baseDir, "home");
        const magentaDir = path.join(homeDir, ".magenta");
        await fs.mkdir(magentaDir, { recursive: true });
        await fs.writeFile(
          path.join(magentaDir, "options.json"),
          JSON.stringify({}),
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Try to read a file from the external directory
      await driver.inputMagentaText(
        `Please read the file ${outsidePath}/restricted-file.txt`,
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll read that file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "restricted_file_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath:
                  `${outsidePath}/restricted-file.txt` as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      // Should require user approval since no filePermissions cover this path
      await driver.assertDisplayBufferContains(
        `👀⏳ May I read file \`${outsidePath}/restricted-file.txt\`?`,
      );
    },
  );
});

it("getFile respects tilde expansion in filePermissions paths", async () => {
  await withDriver(
    {
      setupHome: async (homeDir) => {
        const fs = await import("fs/promises");
        const path = await import("path");

        // Create a directory in home with a test file
        const docsDir = path.join(homeDir, "Documents");
        await fs.mkdir(docsDir, { recursive: true });
        await fs.writeFile(
          path.join(docsDir, "notes.txt"),
          "Notes from home directory",
        );

        // Write ~/.magenta/options.json with tilde-based path
        const magentaDir = path.join(homeDir, ".magenta");
        await fs.mkdir(magentaDir, { recursive: true });
        await fs.writeFile(
          path.join(magentaDir, "options.json"),
          JSON.stringify({
            filePermissions: [{ path: "~/Documents", read: true }],
          }),
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Try to read a file using tilde path
      await driver.inputMagentaText(`Please read ~/Documents/notes.txt`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll read that file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "tilde_file_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "~/Documents/notes.txt" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      // Should be automatically approved via tilde-expanded filePermissions
      await driver.assertDisplayBufferContains(
        `👀✅ \`~/Documents/notes.txt\``,
      );

      // Verify the file content was returned
      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        toolResultRequest.messages,
      );

      expect(toolResultMessage).toBeDefined();
      const contentArray = toolResultMessage!.content as ContentBlockParam[];
      const toolResult = contentArray.find(
        (item: ContentBlockParam) => item.type === "tool_result",
      ) as ToolResultBlockParam;
      expect(toolResult).toBeDefined();
      expect(toolResult.is_error).toBeFalsy();

      assertToolResultContainsText(toolResult, "Notes from home directory");
    },
  );
});

it("getFile can read files using tilde path with user approval", async () => {
  await withDriver(
    {
      setupHome: async (homeDir) => {
        const fs = await import("fs/promises");
        const path = await import("path");

        // Create a file in the home directory
        await fs.writeFile(
          path.join(homeDir, "home-file.txt"),
          "Content from home directory file",
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Try to read a file using tilde path (no filePermissions, so requires approval)
      await driver.inputMagentaText(`Please read ~/home-file.txt`);
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "I'll read that file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "tilde_approval_request" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: {
                filePath: "~/home-file.txt" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      // Should require user approval since no filePermissions cover this path
      await driver.assertDisplayBufferContains(
        `👀⏳ May I read file \`~/home-file.txt\`?`,
      );

      // Approve the request
      const yesPos = await driver.assertDisplayBufferContains("> YES");
      await driver.triggerDisplayBufferKey(yesPos, "<CR>");

      // Should now show success
      await driver.assertDisplayBufferContains(`👀✅ \`~/home-file.txt\``);

      // Verify the file content was returned
      const toolResultRequest = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        toolResultRequest.messages,
      );

      expect(toolResultMessage).toBeDefined();
      const contentArray = toolResultMessage!.content as ContentBlockParam[];
      const toolResult = contentArray.find(
        (item: ContentBlockParam) => item.type === "tool_result",
      ) as ToolResultBlockParam;
      expect(toolResult).toBeDefined();
      expect(toolResult.is_error).toBeFalsy();

      assertToolResultContainsText(
        toolResult,
        "Content from home directory file",
      );
    },
  );
});

it("should show file summary for large file with unknown extension", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const fs = await import("fs/promises");
        const path = await import("path");

        // Create a large file with unknown extension
        const lines: string[] = [];
        for (let i = 0; i < 1000; i++) {
          lines.push(`Line ${i}: ${"x".repeat(50)}`);
        }
        await fs.writeFile(
          path.join(tmpDir, "large.unknown123"),
          lines.join("\n"),
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("Read the large.unknown123 file");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "tool_use",
        text: "I'll read that file",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "tool1" as ToolRequestId,
              toolName: "get_file" as ToolName,
              input: { filePath: "./large.unknown123" as UnresolvedFilePath },
            },
          },
        ],
      });

      // Wait for tool result
      const resultStream = await driver.mockAnthropic.awaitPendingStream();
      const toolResultMessage = MockProvider.findLastToolResultMessage(
        resultStream.messages,
      );

      expect(toolResultMessage).toBeDefined();
      const contentArray = toolResultMessage!.content as ContentBlockParam[];
      const toolResult = contentArray.find(
        (item: ContentBlockParam) => item.type === "tool_result",
      ) as ToolResultBlockParam;
      expect(toolResult).toBeDefined();
      expect(toolResult.is_error).toBeFalsy();

      const toolResultContent = toolResult.content as ContentBlockParam[];
      const textContent = toolResultContent.find(
        (item: ContentBlockParam) => item.type === "text",
      ) as TextBlockParam;

      expect(textContent.text).toContain("[File summary:");
    },
  );
});
