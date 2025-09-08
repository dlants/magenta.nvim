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

      const request = await driver.mockAnthropic.awaitPendingRequest();
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
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      const toolResultMessage =
        toolResultRequest.messages[toolResultRequest.messages.length - 2];

      expect(toolResultMessage.role).toBe("user");
      expect(Array.isArray(toolResultMessage.content)).toBe(true);

      const toolResult = toolResultMessage.content[0] as Extract<
        (typeof toolResultMessage.content)[0],
        { type: "tool_result" }
      >;
      expect(toolResult.type).toBe("tool_result");
      expect(toolResult.result.status).toBe("ok");

      const toolResultResult = toolResult.result as Extract<
        typeof toolResult.result,
        { status: "ok" }
      >;

      const documentContent = toolResultResult.value.find(
        (item) => item.type === "document",
      ) as Extract<(typeof toolResultResult.value)[0], { type: "document" }>;
      expect(documentContent).toBeDefined();

      expect(documentContent.source.type).toBe("base64");
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

      const summaryRequest = await driver.mockAnthropic.awaitPendingRequest();
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

      const summaryToolResult =
        await driver.mockAnthropic.awaitPendingRequest();
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

      const page1Request = await driver.mockAnthropic.awaitPendingRequest();
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

      const page1ToolResult = await driver.mockAnthropic.awaitPendingRequest();
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

      const page3Request = await driver.mockAnthropic.awaitPendingRequest();
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

      const page3ToolResult = await driver.mockAnthropic.awaitPendingRequest();
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

      const page2Request = await driver.mockAnthropic.awaitPendingRequest();
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

      const page2ToolResult = await driver.mockAnthropic.awaitPendingRequest();
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

      const page5Request = await driver.mockAnthropic.awaitPendingRequest();
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

      const page5ToolResult = await driver.mockAnthropic.awaitPendingRequest();
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

      const request = await driver.mockAnthropic.awaitPendingRequest();
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
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      const toolResultMessage =
        toolResultRequest.messages[toolResultRequest.messages.length - 1];

      expect(toolResultMessage.role).toBe("user");
      expect(Array.isArray(toolResultMessage.content)).toBe(true);

      const toolResult = toolResultMessage.content[0] as Extract<
        (typeof toolResultMessage.content)[0],
        { type: "tool_result" }
      >;
      expect(toolResult.type).toBe("tool_result");
      expect(toolResult.result.status).toBe("ok");

      const toolResultResult = toolResult.result as Extract<
        typeof toolResult.result,
        { status: "ok" }
      >;

      const textContent = toolResultResult.value.find(
        (item) => item.type === "text",
      ) as Extract<(typeof toolResultResult.value)[0], { type: "text" }>;
      expect(textContent).toBeDefined();
      expect(textContent.text).toContain("PDF Document: multipage.pdf");
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

      const request = await driver.mockAnthropic.awaitPendingRequest();
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
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      const toolResultMessage =
        toolResultRequest.messages[toolResultRequest.messages.length - 1];

      expect(toolResultMessage.role).toBe("user");
      expect(Array.isArray(toolResultMessage.content)).toBe(true);

      const toolResult = toolResultMessage.content[0] as Extract<
        (typeof toolResultMessage.content)[0],
        { type: "tool_result" }
      >;
      expect(toolResult.type).toBe("tool_result");
      expect(toolResult.result.status).toBe("error");

      const toolResultError = toolResult.result as Extract<
        typeof toolResult.result,
        { status: "error" }
      >;
      expect(toolResultError.error).toContain("Page index 5 is out of range");
      expect(toolResultError.error).toContain("Document has 1 pages");
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

it("getFile requests approval for gitignored file", async () => {
  await withDriver({}, async (driver) => {
    // Get the test working directory and create .gitignore file for this test
    const { getcwd } = await import("../nvim/nvim.ts");
    const { $ } = await import("zx");
    const cwd = await getcwd(driver.nvim);
    await $`cd ${cwd} && echo 'ignored-file.txt' > .gitignore`;

    await driver.showSidebar();
    await driver.inputMagentaText(`Try reading the file ignored-file.txt`);
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
              filePath: "ignored-file.txt" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`\
👀⏳ May I read file \`ignored-file.txt\`?`);
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

    expect(toolResultMessage.role).toBe("user");
    expect(Array.isArray(toolResultMessage.content)).toBe(true);

    const toolResult = toolResultMessage.content.find(
      (item) => item.type === "tool_result",
    ) as Extract<
      (typeof toolResultMessage.content)[0],
      { type: "tool_result" }
    >;
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

    expect(toolResultMessage.role).toBe("user");
    expect(Array.isArray(toolResultMessage.content)).toBe(true);

    const toolResult = toolResultMessage.content.find(
      (item) => item.type === "tool_result",
    ) as Extract<
      (typeof toolResultMessage.content)[0],
      { type: "tool_result" }
    >;
    expect(toolResult).toBeDefined();
    assertToolResultContainsText(
      toolResult,
      "Moonlight whispers through the trees",
    );

    // Verify that the "already part of the thread context" message is NOT present
    const result = toolResult.result as Extract<
      typeof toolResult.result,
      { status: "ok" }
    >;
    expect(result.status).toBe("ok");
    const hasContextText = result.value.some((item) => {
      if (typeof item === "object" && item.type === "text") {
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
    ) as Extract<
      (typeof toolResultMessage.content)[0],
      { type: "tool_result" }
    >;
    expect(toolResult).toBeDefined();

    assertToolResultContainsText(
      toolResult,
      "Moonlight whispers through the trees",
    );

    // Verify the full content is returned, not empty content
    expect(toolResult.result.status).toBe("ok");

    const result = toolResult.result as Extract<
      typeof toolResult.result,
      { status: "ok" }
    >;

    const content = result.value.find(
      (item) => item.type === "text",
    ) as Extract<(typeof result.value)[0], { type: "text" }>;
    expect(content).toBeDefined();

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

it("should process image files end-to-end", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Request to read an image file
    await driver.inputMagentaText(`Please analyze the image in test.jpg`);
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
              filePath: "test.jpg" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    // Should show successful processing
    await driver.assertDisplayBufferContains(`👀✅ \`test.jpg\``);

    // Verify the tool result contains image content
    const toolResultRequest = await driver.mockAnthropic.awaitPendingRequest();
    const toolResultMessage =
      toolResultRequest.messages[toolResultRequest.messages.length - 1];

    expect(toolResultMessage.role).toBe("user");
    expect(Array.isArray(toolResultMessage.content)).toBe(true);

    const toolResult = toolResultMessage.content[0] as Extract<
      (typeof toolResultMessage.content)[0],
      { type: "tool_result" }
    >;
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.result.status).toBe("ok");

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
              filePath: "sample2.pdf" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`sample2.pdf\``);

    // Check that the PDF summary is returned
    const toolResultRequest = await driver.mockAnthropic.awaitPendingRequest();
    const toolResultMessage =
      toolResultRequest.messages[toolResultRequest.messages.length - 1];

    expect(toolResultMessage.role).toBe("user");
    expect(Array.isArray(toolResultMessage.content)).toBe(true);

    const toolResult = toolResultMessage.content.find(
      (item) => item.type === "tool_result",
    ) as Extract<
      (typeof toolResultMessage.content)[0],
      { type: "tool_result" }
    >;
    expect(toolResult).toBeDefined();
    expect(toolResult.result.status).toBe("ok");

    const result = toolResult.result as Extract<
      typeof toolResult.result,
      { status: "ok" }
    >;

    const textContent = result.value.find(
      (item) => item.type === "text",
    ) as Extract<(typeof result.value)[0], { type: "text" }>;
    expect(textContent).toBeDefined();

    // Should contain PDF summary information
    expect(textContent.text).toContain("PDF Document: sample2.pdf");
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
              filePath: "test.bin" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    // Should show error for unsupported file type
    await driver.assertDisplayBufferContains(`👀❌ \`test.bin\``);

    // Verify the tool result contains error
    const toolResultRequest = await driver.mockAnthropic.awaitPendingRequest();
    const toolResultMessage =
      toolResultRequest.messages[toolResultRequest.messages.length - 1];

    expect(toolResultMessage.role).toBe("user");
    expect(Array.isArray(toolResultMessage.content)).toBe(true);

    const toolResult = toolResultMessage.content[0] as Extract<
      (typeof toolResultMessage.content)[0],
      { type: "tool_result" }
    >;
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.result.status).toBe("error");

    const toolResultError = toolResult.result as Extract<
      typeof toolResult.result,
      { status: "error" }
    >;
    expect(toolResultError.error).toContain("Unsupported file type");
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
              filePath: "test.jpg" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`test.jpg\``);

    // Handle the auto-respond message
    const toolResultRequest = await driver.mockAnthropic.awaitPendingRequest();
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
              filePath: "sample2.pdf" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`sample2.pdf\``);

    // Handle the auto-respond message
    const toolResultRequest = await driver.mockAnthropic.awaitPendingRequest();
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
              filePath: "poem.txt" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`poem.txt\``);

    // Handle the auto-respond message
    const toolResultRequest = await driver.mockAnthropic.awaitPendingRequest();
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
              filePath: "poem.txt" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`poem.txt\``);

    // Handle first auto-respond message
    const toolResultRequest1 = await driver.mockAnthropic.awaitPendingRequest();
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
              filePath: "test.jpg" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`test.jpg\``);

    // Handle second auto-respond message
    const toolResultRequest2 = await driver.mockAnthropic.awaitPendingRequest();
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
              filePath: "sample2.pdf" as UnresolvedFilePath,
            },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains(`👀✅ \`sample2.pdf\``);

    // Handle final auto-respond message
    const toolResultRequest3 = await driver.mockAnthropic.awaitPendingRequest();
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
                filePath: "large-image.jpg" as UnresolvedFilePath,
              },
            },
          },
        ],
      });

      // Should show error for file too large
      await driver.assertDisplayBufferContains(`👀❌ \`large-image.jpg\``);

      // Verify the tool result contains error
      const toolResultRequest =
        await driver.mockAnthropic.awaitPendingRequest();
      const toolResultMessage =
        toolResultRequest.messages[toolResultRequest.messages.length - 1];

      expect(toolResultMessage.role).toBe("user");
      expect(Array.isArray(toolResultMessage.content)).toBe(true);

      const toolResult = toolResultMessage.content[0] as Extract<
        (typeof toolResultMessage.content)[0],
        { type: "tool_result" }
      >;
      expect(toolResult.type).toBe("tool_result");
      expect(toolResult.result.status).toBe("error");

      const toolResultError = toolResult.result as Extract<
        typeof toolResult.result,
        { status: "error" }
      >;
      expect(toolResultError.error).toContain("File too large");

      // No cleanup needed since the file is in the temporary test directory
    },
  );
});
