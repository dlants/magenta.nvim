import { describe, expect, it } from "vitest";
import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "../tools/toolManager";
import type { ToolName } from "../tools/types";
import { getCurrentBuffer, getCurrentWindow } from "../nvim/nvim";
import type { Line } from "../nvim/buffer";
import type { Position0Indexed, Row0Indexed } from "../nvim/window";
import { AnthropicAgent } from "../providers/anthropic-agent";

describe("node/inline-edit/inline-edit-app.spec.ts", () => {
  it("performs inline edit on file", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("poem.txt");
      const targetBuffer = await getCurrentBuffer(driver.nvim);
      await driver.startInlineEdit();

      // Verify inline edit window opened
      await driver.assertWindowCount(2);

      const inputWindow = await getCurrentWindow(driver.nvim);
      const winbar = await inputWindow.getOption("winbar");
      expect(winbar).toEqual("Magenta Inline Prompt");

      const mode = await driver.nvim.call("nvim_get_mode", []);
      expect(mode).toEqual({ mode: "i", blocking: false });

      const inputBuffer = await getCurrentBuffer(driver.nvim);
      await inputBuffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["Please change 'Silver' to 'Golden' in line 2"] as Line[],
      });
      await driver.submitInlineEdit(targetBuffer.id);
      const request =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest();
      expect(request.input).toMatchSnapshot();

      const inputLines = await inputBuffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      expect(inputLines.join("\n")).toEqual("Input sent, awaiting response...");

      await driver.mockAnthropic.respondToForceToolUse({
        stopReason: "tool_use",
        toolRequest: {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "inline_edit" as ToolName,
            input: {
              find: "Silver shadows dance with ease.",
              replace: "Golden shadows dance with ease.",
            },
          },
        },
      });

      await driver.assertBufferContains(
        targetBuffer,
        `\
Golden shadows dance with ease.`,
      );

      // Verify the input buffer is destroyed after successful edit
      await driver.assertWindowCount(1);
    });
  });

  it("can do multiple inline edits on same file", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("poem.txt");
      const targetBuffer = await getCurrentBuffer(driver.nvim);
      await driver.startInlineEdit();
      await driver.assertWindowCount(2);

      {
        const inputWindow = await getCurrentWindow(driver.nvim);
        await inputWindow.close();
      }
      await driver.assertWindowCount(1);

      // open inline edit again
      await driver.startInlineEdit();
      await driver.assertWindowCount(2);

      const inputBuffer = await getCurrentBuffer(driver.nvim);
      await inputBuffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["Please change 'Silver' to 'Golden' in line 2"] as Line[],
      });
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      driver.submitInlineEdit(targetBuffer.id);
      await driver.mockAnthropic.awaitPendingForceToolUseRequest();

      const inputLines = await inputBuffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      expect(inputLines.join("\n")).toEqual("Input sent, awaiting response...");
    });
  });

  it("resets existing inline edit when starting new one on same buffer", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("poem.txt");
      const targetWindow = await getCurrentWindow(driver.nvim);
      const targetBuffer = await getCurrentBuffer(driver.nvim);

      // Start first inline edit
      await driver.startInlineEdit();
      await driver.assertWindowCount(2);

      const firstInputBuffer = await getCurrentBuffer(driver.nvim);
      await firstInputBuffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["First edit request"] as Line[],
      });

      // Focus back on the target window before starting second inline edit
      await driver.nvim.call("nvim_set_current_win", [targetWindow.id]);

      // Start second inline edit without closing the first
      await driver.startInlineEdit();
      await driver.assertWindowCount(2); // Should still have 2 windows

      // Verify we have a fresh input buffer with empty content
      const secondInputBuffer = await getCurrentBuffer(driver.nvim);
      const lines = await secondInputBuffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      expect(lines).toEqual([""]); // Fresh buffer should be empty

      // Verify we can use the new inline edit
      await secondInputBuffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["Second edit request"] as Line[],
      });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      driver.submitInlineEdit(targetBuffer.id);
      const request =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest();

      // Verify the request contains the second edit content, not the first
      const firstInput = request.input[0];
      expect(firstInput?.type).toBe("text");
      if (firstInput?.type === "text") {
        expect(firstInput.text).toContain("Second edit request");
        expect(firstInput.text).not.toContain("First edit request");
      }
    });
  });

  it("performs inline edit with selection", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("poem.txt");
      const targetBuffer = await getCurrentBuffer(driver.nvim);

      // Select a range of text
      await driver.selectRange(
        { row: 1, col: 0 } as Position0Indexed,
        { row: 1, col: 32 } as Position0Indexed,
      );

      await driver.startInlineEditWithSelection();
      await driver.assertWindowCount(2);

      const inputBuffer = await getCurrentBuffer(driver.nvim);
      await inputBuffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["Please change 'Silver' to 'Golden'"] as Line[],
      });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      driver.submitInlineEdit(targetBuffer.id);
      const request =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest();
      expect(request.input).toMatchSnapshot();
    });
  });

  it("inline edit end of line selected", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("poem.txt");
      const targetBuffer = await getCurrentBuffer(driver.nvim);

      // Select a range of text
      await driver.selectRange(
        { row: 1, col: 0 } as Position0Indexed,
        { row: 2, col: 34 } as Position0Indexed,
      );

      await driver.startInlineEditWithSelection();
      await driver.assertWindowCount(2);

      const inputBuffer = await getCurrentBuffer(driver.nvim);
      await inputBuffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["Please change 'Silver' to 'Golden'"] as Line[],
      });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      driver.submitInlineEdit(targetBuffer.id);
      const request =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest();
      expect(request.input).toMatchSnapshot();
      await driver.mockAnthropic.respondToForceToolUse({
        stopReason: "tool_use",
        toolRequest: {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "replace_selection" as ToolName,
            input: {
              replace:
                "Golden shadows dance with ease.\nStars above like diamonds bright,",
            },
          },
        },
      });

      await driver.assertBufferContains(
        targetBuffer,
        `\
Moonlight whispers through the trees,
Golden shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.`,
      );

      // Verify the input buffer is destroyed after successful edit
      await driver.assertWindowCount(1);
    });
  });

  it("inline edit mid-line selected", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("poem.txt");
      const targetBuffer = await getCurrentBuffer(driver.nvim);

      // Select a range of text
      await driver.selectRange(
        { row: 1, col: 7 } as Position0Indexed,
        { row: 2, col: 5 } as Position0Indexed,
      );

      await driver.startInlineEditWithSelection();
      await driver.assertWindowCount(2);

      const inputBuffer = await getCurrentBuffer(driver.nvim);
      await inputBuffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["Please change 'shadows' to 'ghosts'"] as Line[],
      });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      driver.submitInlineEdit(targetBuffer.id);
      const request =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest();
      expect(request.input).toMatchSnapshot();
      await driver.mockAnthropic.respondToForceToolUse({
        stopReason: "tool_use",
        toolRequest: {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "replace_selection" as ToolName,
            input: {
              replace: "ghosts dance with ease.\nStars",
            },
          },
        },
      });

      await driver.assertBufferContains(
        targetBuffer,
        `\
Moonlight whispers through the trees,
Silver ghosts dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.`,
      );

      // Verify the input buffer is destroyed after successful edit
      await driver.assertWindowCount(1);
    });
  });

  it("shows error message when inline edit fails", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("poem.txt");
      const targetBuffer = await getCurrentBuffer(driver.nvim);
      await driver.startInlineEdit();

      await driver.assertWindowCount(2);

      const inputBuffer = await getCurrentBuffer(driver.nvim);
      await inputBuffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["Please change 'Silver' to 'Golden' in line 2"] as Line[],
      });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      driver.submitInlineEdit(targetBuffer.id);
      await driver.mockAnthropic.awaitPendingForceToolUseRequest();

      // Respond with a failed tool request
      await driver.mockAnthropic.respondToForceToolUse({
        stopReason: "tool_use",
        toolRequest: {
          status: "error",
          error: "Unable to find the specified text to replace",
          rawRequest: {},
        },
      });

      // Verify the input buffer shows the error message and remains open
      await driver.assertBufferContains(
        inputBuffer,
        "Error: Unable to find the specified text to replace",
      );

      // Verify the input buffer window is still open (not closed like successful edits)
      await driver.assertWindowCount(2);

      // Verify the target buffer was not modified
      await driver.assertBufferContains(
        targetBuffer,
        "Silver shadows dance with ease.",
      );
    });
  });

  it("abort command should work", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("poem.txt");
      const targetBuffer = await getCurrentBuffer(driver.nvim);

      // Select a range of text
      await driver.selectRange(
        { row: 1, col: 0 } as Position0Indexed,
        { row: 1, col: 32 } as Position0Indexed,
      );

      await driver.startInlineEditWithSelection();
      await driver.assertWindowCount(2);

      const inputBuffer = await getCurrentBuffer(driver.nvim);
      await inputBuffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["Please change 'Silver' to 'Golden'"] as Line[],
      });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      driver.submitInlineEdit(targetBuffer.id);
      const request =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest();
      expect(request.defer.resolved).toBe(false);

      await driver.abort();
      expect(request.defer.resolved).toBe(true);
    });
  });
  it("uses fast model when input starts with @fast", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("poem.txt");
      const targetBuffer = await getCurrentBuffer(driver.nvim);
      await driver.startInlineEdit();

      const inputBuffer = await getCurrentBuffer(driver.nvim);
      await inputBuffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["@fast Please change 'Silver' to 'Golden' in line 2"] as Line[],
      });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      driver.submitInlineEdit(targetBuffer.id);
      const request =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest();

      // Should use fast model
      expect(request.model).toBe("mock-fast");

      // Should not include @fast in the message content
      const firstInput = request.input[0];
      expect(firstInput?.type).toBe("text");
      if (firstInput?.type === "text") {
        expect(firstInput.text).not.toContain("@fast");
        expect(firstInput.text).toContain(
          "Please change 'Silver' to 'Golden' in line 2",
        );
      }
    });
  });

  it("uses fast model with @fast and whitespace", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("poem.txt");
      const targetBuffer = await getCurrentBuffer(driver.nvim);
      await driver.startInlineEdit();

      const inputBuffer = await getCurrentBuffer(driver.nvim);
      await inputBuffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: [
          "  @fast   Please change 'Silver' to 'Golden' in line 2",
        ] as Line[],
      });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      driver.submitInlineEdit(targetBuffer.id);
      const request =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest();

      // Should use fast model
      expect(request.model).toBe("mock-fast");

      // Should not include @fast or leading whitespace in the message content
      const firstInput = request.input[0];
      expect(firstInput?.type).toBe("text");
      if (firstInput?.type === "text") {
        expect(firstInput.text).not.toContain("@fast");
        expect(firstInput.text).toContain(
          "Please change 'Silver' to 'Golden' in line 2",
        );
      }
    });
  });

  it("replays inline edit with same input", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("poem.txt");
      const targetBuffer = await getCurrentBuffer(driver.nvim);

      // First, do an inline edit
      await driver.startInlineEdit();
      const inputBuffer = await getCurrentBuffer(driver.nvim);
      await inputBuffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["Please change 'Silver' to 'Golden' in line 2"] as Line[],
      });

      // Submit and complete the first edit
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      driver.submitInlineEdit(targetBuffer.id);
      const firstRequest =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest();
      await driver.mockAnthropic.respondToForceToolUse({
        stopReason: "tool_use",
        toolRequest: {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "inline_edit" as ToolName,
            input: {
              find: "Silver shadows dance with ease.",
              replace: "Golden shadows dance with ease.",
            },
          },
        },
      });

      // Close the input window
      const inputWindow = await getCurrentWindow(driver.nvim);
      await inputWindow.close();

      // Now replay the inline edit
      await driver.replayInlineEdit();
      await driver.assertWindowCount(2);

      const replayInputBuffer = await getCurrentBuffer(driver.nvim);
      const winbar = await (
        await getCurrentWindow(driver.nvim)
      ).getOption("winbar");
      expect(winbar).toEqual("Magenta Inline Prompt");

      // Verify the request was immediately sent (no pre-populated input)
      const lines = await replayInputBuffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      expect(lines.join("\n")).toEqual("Input sent, awaiting response...");

      const replayRequest =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest();

      // Verify the requests have the same user input text
      const firstInput = firstRequest.input[0];
      const replayInput = replayRequest.input[0];

      expect(firstInput?.type).toBe("text");
      expect(replayInput?.type).toBe("text");

      if (firstInput?.type === "text" && replayInput?.type === "text") {
        // Both should contain the same user input
        expect(replayInput.text).toContain(
          "Please change 'Silver' to 'Golden' in line 2",
        );
        expect(firstInput.text).toContain(
          "Please change 'Silver' to 'Golden' in line 2",
        );
      }
    });
  });

  it("replays inline edit with selection", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("poem.txt");
      const targetBuffer = await getCurrentBuffer(driver.nvim);
      const targetWindow = await getCurrentWindow(driver.nvim);

      // First, do an inline edit with selection
      await driver.selectRange(
        { row: 1, col: 0 } as Position0Indexed,
        { row: 1, col: 32 } as Position0Indexed,
      );
      await driver.startInlineEditWithSelection();

      const inputBuffer = await getCurrentBuffer(driver.nvim);
      await inputBuffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["Please change 'Silver' to 'Golden'"] as Line[],
      });

      // Submit and complete the first edit
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      driver.submitInlineEdit(targetBuffer.id);
      await driver.mockAnthropic.awaitPendingForceToolUseRequest();
      await driver.mockAnthropic.respondToForceToolUse({
        stopReason: "tool_use",
        toolRequest: {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "replace_selection" as ToolName,
            input: {
              replace: "Golden shadows dance with ease.",
            },
          },
        },
      });

      await driver.nvim.call("nvim_set_current_win", [targetWindow.id]);

      // Now replay with a new selection
      await driver.selectRange(
        { row: 2, col: 0 } as Position0Indexed,
        { row: 2, col: 34 } as Position0Indexed,
      );
      await driver.replayInlineEditWithSelection();
      await driver.assertWindowCount(2);

      const replayRequest =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest();

      // Verify the request uses replace_selection tool and has the new selection
      const firstInput = replayRequest.input[0];
      expect(firstInput?.type).toBe("text");

      expect(
        (firstInput as Extract<typeof firstInput, { type: "text" }>).text,
      ).toContain("I have the following text selected on line 2:");
      expect(
        (firstInput as Extract<typeof firstInput, { type: "text" }>).text,
      ).toContain("Stars above like diamonds bright");
      expect(
        (firstInput as Extract<typeof firstInput, { type: "text" }>).text,
      ).toContain("Please change 'Silver' to 'Golden'");
    });
  });

  it("passes sidebar thread context to inline edit request", async () => {
    await withDriver({}, async (driver) => {
      // First, send a message through the sidebar to establish context
      await driver.showSidebar();
      await driver.inputMagentaText("Tell me about the poem");
      await driver.send();

      // Wait for and respond to the sidebar message
      const sidebarStream = await driver.mockAnthropic.awaitPendingStream();
      sidebarStream.respond({
        stopReason: "end_turn",
        text: "The poem describes moonlight and nature scenes.",
        toolRequests: [],
      });

      // Respond to the title generation request
      await driver.mockAnthropic.respondToForceToolUse({
        stopReason: "tool_use",
        toolRequest: {
          status: "ok",
          value: {
            id: "title-id" as ToolRequestId,
            toolName: "set_title" as ToolName,
            input: { title: "Poem Discussion" },
          },
        },
      });

      // Wait for the response to complete
      await driver.assertDisplayBufferContains(
        "The poem describes moonlight and nature scenes.",
      );

      // Find a non-sidebar window to open the file in
      const fileWindow = await driver.findWindow(async (w) => {
        const isMagenta = await w.getVar("magenta").catch(() => false);
        return !isMagenta;
      });
      await driver.nvim.call("nvim_set_current_win", [fileWindow.id]);

      // Now open a file and start an inline edit
      await driver.editFile("poem.txt");
      const targetBuffer = await getCurrentBuffer(driver.nvim);
      await driver.startInlineEdit();
      await driver.assertWindowCount(4); // sidebar display + sidebar input + file window + inline input

      const inputBuffer = await getCurrentBuffer(driver.nvim);
      await inputBuffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["Change Silver to Golden"] as Line[],
      });

      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      driver.submitInlineEdit(targetBuffer.id);
      const forceRequest =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest();

      // Verify that the contextAgent is present and contains the sidebar messages
      expect(forceRequest.contextAgent).toBeDefined();
      expect(forceRequest.contextAgent).toBeInstanceOf(AnthropicAgent);

      const contextMessages = (
        forceRequest.contextAgent as AnthropicAgent
      ).getNativeMessages();

      // Should have at least 2 messages: user message and assistant response
      expect(contextMessages.length).toBeGreaterThanOrEqual(2);

      // Find the user message with our sidebar text
      const userMessage = contextMessages.find(
        (msg) =>
          msg.role === "user" &&
          Array.isArray(msg.content) &&
          msg.content.some(
            (block) =>
              block.type === "text" &&
              block.text.includes("Tell me about the poem"),
          ),
      );
      expect(userMessage).toBeDefined();

      // Find the assistant response
      const assistantMessage = contextMessages.find(
        (msg) =>
          msg.role === "assistant" &&
          Array.isArray(msg.content) &&
          msg.content.some(
            (block) =>
              block.type === "text" &&
              block.text.includes("moonlight and nature scenes"),
          ),
      );
      expect(assistantMessage).toBeDefined();
    });
  });
});
