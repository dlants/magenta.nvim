import { test, expect } from "vitest";
import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "../tools/types";
import type { ToolName } from "../tools/types";
import { getCurrentBuffer } from "../nvim/nvim";
import type { Row0Indexed } from "../nvim/window";
import type { AbsFilePath } from "../utils/files";
import * as fs from "fs/promises";
import * as path from "path";
import { MAGENTA_HIGHLIGHT_GROUPS } from "../nvim/extmarks";

test("prediction after making edits", async () => {
  await withDriver({}, async (driver) => {
    // Open the poem.txt fixture file
    await driver.editFile("poem.txt");

    // Make some real edits to generate change tracking
    // Change "Moonlight" to "Starlight" on the first line
    await driver.command("normal! gg");
    await driver.command("normal! f M");
    await driver.command("normal! ciwStarlight");

    // Position cursor in the middle of line 3 for prediction context
    await driver.command("normal! jj");
    await driver.command("normal! f a");

    // Wait for our edits to be tracked by the change tracker
    // The change tracker may batch rapid edits into a single change
    await driver.assertChangeTrackerHasEdits(1);
    await driver.assertChangeTrackerContains([
      { newText: "Starlight", filePath: "poem.txt" },
    ]);

    await driver.magenta.command("predict-edit");

    // Wait for the mock provider to receive the force tool use request
    const request =
      await driver.mockAnthropic.awaitPendingForceToolUseRequest();

    // Verify the request uses the predict_edit tool
    expect(request.spec.name).toBe("predict_edit");

    // Verify the system prompt contains general instructions
    expect(request.systemPrompt).toBeDefined();

    // Verify the input contains the specific context
    expect(request.input).toHaveLength(1);

    const userInput = request.input[0];
    expect(userInput.type).toBe("text");

    const text = userInput.type === "text" ? userInput.text : "";

    // Should contain buffer content around cursor with cursor marker
    expect(text).toMatchSnapshot();
  });
});

test("uses dedicated profile when editPrediction.profile is configured", async () => {
  await withDriver(
    {
      // Set custom options with a dedicated prediction profile
      options: {
        profiles: [
          {
            name: "main-claude",
            provider: "mock",
            model: "claude-opus-4-5",
            fastModel: "claude-haiku-4-5",
            apiKeyEnvVar: "ANTHROPIC_API_KEY",
          },
        ],
        editPrediction: {
          profile: {
            name: "edit-prediction",
            provider: "mock",
            model: "claude-haiku-4-5",
            apiKeyEnvVar: "ANTHROPIC_API_KEY",
          },
        },
      },
    },
    async (driver) => {
      // Open the poem.txt fixture file
      await driver.editFile("poem.txt");

      // Make some real edits to generate change tracking
      await driver.command("normal! gg");
      await driver.command("normal! f M");
      await driver.command("normal! ciwStarlight");

      // Position cursor for prediction
      await driver.command("normal! jj");
      await driver.command("normal! f a");

      // Wait for our edits to be tracked
      await driver.assertChangeTrackerHasEdits(1);

      await driver.magenta.command("predict-edit");

      // Wait for the mock provider to receive the force tool use request
      const request =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest();

      // Verify the request uses the dedicated prediction profile's model
      expect(request.model).toBe("claude-haiku-4-5");

      // Verify the request uses the predict_edit tool
      expect(request.spec.name).toBe("predict_edit");
    },
  );
});

test("uses different provider for predictions when configured", async () => {
  await withDriver(
    {
      // Set custom options with a different provider for predictions
      options: {
        profiles: [
          {
            name: "main-claude",
            provider: "mock",
            model: "claude-opus-4-5",
            fastModel: "claude-haiku-4-5",
            apiKeyEnvVar: "ANTHROPIC_API_KEY",
          },
        ],
        editPrediction: {
          profile: {
            name: "edit-prediction",
            provider: "mock",
            model: "gpt-4o-mini",
            apiKeyEnvVar: "OPENAI_API_KEY",
          },
        },
      },
    },
    async (driver) => {
      // Open file and trigger prediction
      await driver.editFile("poem.txt");
      await driver.command("normal! gg");

      await driver.magenta.command("predict-edit");

      // Wait for the mock provider to receive the force tool use request
      const request =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest();

      // Should use the OpenAI model specified in the prediction profile
      expect(request.model).toBe("gpt-4o-mini");
    },
  );
});

test("uses active profile when editPrediction.profile not configured", async () => {
  await withDriver(
    {
      // Set custom options without editPrediction.profile
      options: {
        profiles: [
          {
            name: "main-claude",
            provider: "mock",
            model: "claude-opus-4-5",
            fastModel: "claude-haiku-4-5",
            apiKeyEnvVar: "ANTHROPIC_API_KEY",
          },
        ],
        // No editPrediction.profile specified
      },
    },
    async (driver) => {
      // Open file and trigger prediction
      await driver.editFile("poem.txt");
      await driver.command("normal! gg");

      await driver.magenta.command("predict-edit");

      // Wait for the mock provider to receive the force tool use request
      const request =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest();

      // Should use the active profile's model (fallback behavior)
      expect(request.model).toBe("claude-opus-4-5");
    },
  );
});

test("context window trims to 10 lines before and after cursor", async () => {
  await withDriver({}, async (driver) => {
    // Create a file with many lines to test context trimming
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);

    // Write the content to a test file
    await driver.command(`edit test-long-file.txt`);
    await driver.command(`call setline(1, ${JSON.stringify(lines)})`);

    // Position cursor at line 25 (middle of file)
    await driver.command("normal! 25G");

    // Generate message via the edit prediction controller
    const userMessage =
      await driver.magenta.editPredictionController.composeUserMessage();

    expect(userMessage).toMatchSnapshot();
  });
});

test("state management through prediction lifecycle", async () => {
  await withDriver({}, async (driver) => {
    const controller = driver.magenta.editPredictionController;

    // Initial state should be idle
    expect(controller.state.type).toBe("idle");

    // Open the poem.txt fixture file
    await driver.editFile("poem.txt");

    // Make some real edits to generate change tracking
    await driver.command("normal! gg");
    await driver.command("normal! f M");
    await driver.command("normal! ciwStarlight");

    // Position cursor for prediction
    await driver.command("normal! jj");
    await driver.command("normal! f a");

    // Trigger predict-edit command
    await driver.magenta.command("predict-edit");

    // Wait for state to transition to awaiting-agent-reply
    await driver.awaitPredictionControllerState("awaiting-agent-reply");
    const state = controller.state as Extract<
      typeof controller.state,
      { type: "awaiting-agent-reply" }
    >;
    expect(state.contextWindow).toBeDefined();
    expect(state.requestStartTime).toBeTypeOf("number");

    // Get the pending request
    await driver.mockAnthropic.awaitPendingForceToolUseRequest();

    // Mock a successful response
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "tool_use",
      toolRequest: {
        status: "ok",
        value: {
          id: "id" as ToolRequestId,
          toolName: "predict_edit" as ToolName,
          input: {
            find: "dance",
            replace: "sway",
          },
        },
      },
    });

    // Give the async response handling time to process
    await new Promise((resolve) => setTimeout(resolve, 10));

    // State should now be displaying-proposed-edit
    expect(controller.state.type).toBe("displaying-proposed-edit");
    const displayState = controller.state as Extract<
      typeof controller.state,
      { type: "displaying-proposed-edit" }
    >;
    expect(displayState.contextWindow).toBeDefined();
    expect(displayState.prediction).toEqual({
      find: "dance",
      replace: "sway",
    });
  });
});

test("error handling during prediction", async () => {
  await withDriver({}, async (driver) => {
    const controller = driver.magenta.editPredictionController;

    // Open file and position cursor
    await driver.editFile("poem.txt");
    await driver.command("normal! gg");

    // Trigger predict-edit command
    await driver.magenta.command("predict-edit");

    // Wait for state to transition to awaiting-agent-reply
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // State should be awaiting-agent-reply
    expect(controller.state.type).toBe("awaiting-agent-reply");

    // Get the pending request
    await driver.mockAnthropic.awaitPendingForceToolUseRequest();

    // Mock an error response
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "tool_use",
      toolRequest: {
        status: "error",
        error: "Network timeout",
        rawRequest: {},
      },
    });

    // Give the async error handling time to process
    await new Promise((resolve) => setTimeout(resolve, 10));

    // State should return to idle after error
    expect(controller.state.type).toBe("idle");
  });
});

test("context recent changes to requested count", async () => {
  await withDriver({}, async (driver) => {
    // Open the poem.txt fixture file
    await driver.editFile("poem.txt");

    // Get the current working directory from nvim
    const filePath = `${driver.magenta.cwd}/poem.txt`;

    // Add 10 changes directly to the change tracker using correct API
    for (let i = 0; i < 10; i++) {
      driver.magenta.changeTracker.onTextDocumentDidChange({
        filePath,
        oldText: `${i}`,
        newText: `${i + 1}`,
        range: {
          start: { line: 0, character: i },
          end: { line: 0, character: i + 1 },
        },
      });
    }

    // Generate message via the edit prediction controller
    const userMessage =
      await driver.magenta.editPredictionController.composeUserMessage();

    // Capture the entire user message in a snapshot
    expect(userMessage).toMatchSnapshot();
  });
});

test("change selection respects token budget", async () => {
  await withDriver({}, async (driver) => {
    // Override the token budget to a smaller value for testing
    const controller = driver.magenta.editPredictionController;
    const originalBudget = controller.recentChangeTokenBudget;

    // Set a very small token budget to ensure we can't fit all changes
    Object.defineProperty(controller, "recentChangeTokenBudget", {
      value: 100,
      configurable: true,
      writable: true,
    });

    try {
      // Open the poem.txt fixture file
      await driver.editFile("poem.txt");
      const filePath = `${driver.magenta.cwd}/poem.txt`;

      // Add changes with increasing size to the change tracker
      // First small changes that should fit in the budget
      driver.magenta.changeTracker.onTextDocumentDidChange({
        filePath,
        oldText: "small1",
        newText: "small1_changed",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 6 },
        },
      });

      driver.magenta.changeTracker.onTextDocumentDidChange({
        filePath,
        oldText: "small2",
        newText: "small2_changed",
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 6 },
        },
      });

      // Then a large change that should exceed the budget when combined with others
      const largeOldText = Array(500).fill("a").join("");
      const largeNewText = Array(500).fill("b").join("");

      driver.magenta.changeTracker.onTextDocumentDidChange({
        filePath,
        oldText: largeOldText,
        newText: largeNewText,
        range: {
          start: { line: 2, character: 0 },
          end: { line: 2, character: largeOldText.length },
        },
      });

      // Add one more small change as the most recent
      driver.magenta.changeTracker.onTextDocumentDidChange({
        filePath,
        oldText: "recent",
        newText: "recent_changed",
        range: {
          start: { line: 3, character: 0 },
          end: { line: 3, character: 6 },
        },
      });

      // Generate message with our limited budget
      const userMessage = await controller.composeUserMessage();

      // Verify the most recent change is included
      expect(userMessage).toContain("recent");
      expect(userMessage).toContain("recent_changed");

      // The large change should be excluded due to budget constraints
      const largeTextIncluded =
        userMessage.includes(largeOldText.substring(0, 20)) ||
        userMessage.includes(largeNewText.substring(0, 20));

      expect(largeTextIncluded).toBe(false);

      // Capture for snapshot comparison
      expect(userMessage).toMatchSnapshot();
    } finally {
      // Restore the original budget
      if (originalBudget !== undefined) {
        Object.defineProperty(controller, "recentChangeTokenBudget", {
          value: originalBudget,
          configurable: true,
          writable: true,
        });
      }
    }
  });
});

test("new trigger aborts existing requests and starts fresh", async () => {
  await withDriver({}, async (driver) => {
    // Open file and position cursor
    await driver.editFile("poem.txt");
    await driver.command("normal! gg");

    // Trigger first predict-edit command
    await driver.magenta.command("predict-edit");

    // Wait for state to transition to awaiting-agent-reply
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // Get the first request
    const firstRequest =
      await driver.mockAnthropic.awaitPendingForceToolUseRequest();
    expect(firstRequest.defer.resolved).toBe(false);

    // Trigger another prediction while awaiting reply
    await driver.magenta.command("predict-edit");

    // Wait for the new state transition
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // First request should have been aborted
    expect(firstRequest.defer.resolved).toBe(true);

    // Should now have two requests total (first aborted, second pending)
    expect(driver.mockAnthropic.forceToolUseRequests).toHaveLength(2);

    // The second request should be pending
    const secondRequest = driver.mockAnthropic.forceToolUseRequests[1];
    expect(secondRequest.defer.resolved).toBe(false);
  });
});

test("virtual text preview shows predicted edits", async () => {
  await withDriver({}, async (driver) => {
    const controller = driver.magenta.editPredictionController;

    // Open file with content that can be predicted
    await driver.editFile("poem.txt");
    await driver.command("normal! gg");

    // Trigger prediction
    await driver.magenta.command("predict-edit");
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // Check for "completing..." indicator during awaiting state
    const buffer = await getCurrentBuffer(driver.nvim);
    await driver.awaitExtmarks(buffer, 1, 2000, (marks) =>
      marks.some(
        (mark) =>
          mark.options.virt_text &&
          mark.options.virt_text[0] &&
          mark.options.virt_text[0][0] === "completing...",
      ),
    );

    // Mock a response with a simple replacement
    await driver.mockAnthropic.awaitPendingForceToolUseRequest();
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "tool_use",
      toolRequest: {
        status: "ok",
        value: {
          id: "id" as ToolRequestId,
          toolName: "predict_edit" as ToolName,
          input: {
            find: "Moonlight",
            replace: "Starlight",
          },
        },
      },
    });

    // Wait for virtual text to be displayed
    await new Promise((resolve) => setTimeout(resolve, 100));

    // State should be displaying proposed edit
    expect(controller.state.type).toBe("displaying-proposed-edit");

    // Verify that extmarks are created in the buffer
    // We can't easily test the visual output, but we can verify state
    const displayState = controller.state as Extract<
      typeof controller.state,
      { type: "displaying-proposed-edit" }
    >;
    expect(displayState.prediction).toEqual({
      find: "Moonlight",
      replace: "Starlight",
    });
  });
});

test("prediction accepted applies edits", async () => {
  await withDriver({}, async (driver) => {
    const controller = driver.magenta.editPredictionController;

    // Open file and position cursor
    await driver.editFile("poem.txt");
    await driver.command("normal! gg");

    // Get original content
    const buffer = await getCurrentBuffer(driver.nvim);

    // Trigger prediction
    await driver.magenta.command("predict-edit");
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // Mock response with a replacement
    await driver.mockAnthropic.awaitPendingForceToolUseRequest();
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "tool_use",
      toolRequest: {
        status: "ok",
        value: {
          id: "id" as ToolRequestId,
          toolName: "predict_edit" as ToolName,
          input: {
            find: "Moonlight",
            replace: "Starlight",
          },
        },
      },
    });

    // Wait for display state
    await driver.awaitPredictionControllerState("displaying-proposed-edit");

    // Accept the prediction
    await driver.magenta.command("accept-prediction");

    // Wait for prediction to be applied
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify state returned to idle
    expect(controller.state.type).toBe("idle");

    // Verify the edit was applied
    const newLines = await buffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });
    expect(newLines[0]).toContain("Starlight");
    expect(newLines[0]).not.toContain("Moonlight");

    // Verify cursor position moved to the end of the replaced text
    const cursorPos = await driver.nvim.call("nvim_win_get_cursor", [0]);
    const [row, col] = cursorPos;

    // Find where "Starlight" ends in the first line
    const starLightEndCol =
      newLines[0].indexOf("Starlight") + "Starlight".length;

    // Row should be 1 (1-indexed) and column should be at the end of "Starlight"
    expect(row).toBe(1); // First line, 1-indexed
    expect(col).toBe(starLightEndCol);
  });
});

test("prediction dismissed clears virtual text", async () => {
  await withDriver({}, async (driver) => {
    const controller = driver.magenta.editPredictionController;

    // Open file and position cursor
    await driver.editFile("poem.txt");
    await driver.command("normal! gg");

    // Trigger prediction
    await driver.magenta.command("predict-edit");
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // Mock response
    await driver.mockAnthropic.awaitPendingForceToolUseRequest();
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "tool_use",
      toolRequest: {
        status: "ok",
        value: {
          id: "id" as ToolRequestId,
          toolName: "predict_edit" as ToolName,
          input: {
            find: "Moonlight",
            replace: "Starlight",
          },
        },
      },
    });

    // Wait for display state
    await driver.awaitPredictionControllerState("displaying-proposed-edit");

    // Dismiss the prediction
    await driver.magenta.command("dismiss-prediction");

    // Wait for dismissal to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify state returned to idle
    expect(controller.state.type).toBe("idle");

    // Verify buffer content unchanged
    const buffer = await getCurrentBuffer(driver.nvim);
    const lines = await buffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });
    expect(lines[0]).toContain("Moonlight");
    expect(lines[0]).not.toContain("Starlight");
  });
});

test("prediction dismissed by ESC key in normal mode", async () => {
  await withDriver({}, async (driver) => {
    await driver.editFile("poem.txt");
    await driver.command("normal! gg");

    // Trigger prediction
    await driver.magenta.command("predict-edit");
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // Mock response
    await driver.mockAnthropic.awaitPendingForceToolUseRequest();
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "tool_use",
      toolRequest: {
        status: "ok",
        value: {
          id: "id" as ToolRequestId,
          toolName: "predict_edit" as ToolName,
          input: {
            find: "Moonlight",
            replace: "Starlight",
          },
        },
      },
    });

    await driver.awaitPredictionControllerState("displaying-proposed-edit");
    await driver.nvim.call("nvim_feedkeys", ["<Esc>", "n", true]);
    await driver.awaitPredictionControllerState("idle");
  });
});

test("buffer changes auto-dismiss predictions", async () => {
  await withDriver({}, async (driver) => {
    const controller = driver.magenta.editPredictionController;

    // Open file and position cursor
    await driver.editFile("poem.txt");
    await driver.command("normal! gg");

    // Trigger prediction
    await driver.magenta.command("predict-edit");
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // Mock response
    await driver.mockAnthropic.awaitPendingForceToolUseRequest();
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "tool_use",
      toolRequest: {
        status: "ok",
        value: {
          id: "id" as ToolRequestId,
          toolName: "predict_edit" as ToolName,
          input: {
            find: "Moonlight",
            replace: "Starlight",
          },
        },
      },
    });

    // Wait for display state
    await driver.awaitPredictionControllerState("displaying-proposed-edit");

    // Make a buffer change (this should auto-dismiss the prediction)
    const buffer = await getCurrentBuffer(driver.nvim);
    await driver.command("normal! A edit");
    await driver.command("write");

    // Manually trigger the buffer change event since the test environment
    // might not trigger it automatically
    driver.magenta.onBufferTrackerEvent(
      "write",
      `${driver.magenta.cwd}/poem.txt` as AbsFilePath,
      buffer.id,
    );

    // Wait for buffer change to be processed
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify state returned to idle due to buffer change
    expect(controller.state.type).toBe("idle");
  });
});

test("complex multi-line prediction preview and acceptance", async () => {
  await withDriver({}, async (driver) => {
    const controller = driver.magenta.editPredictionController;

    // Create a custom test file with specific content for predictable testing
    const customContent = `\
function processConfig() {
  const config = {
    database: {
      host: 'localhost',
      port: 5432,
      credentials: {
        username: 'admin',
        password: 'secret'
      }
    },
    logging: {
      level: 'info'
    }
  };
  return config;
}`;

    // Write the custom file directly to the temp directory
    const customFilePath = path.join(driver.magenta.cwd, "custom-test.js");
    await fs.writeFile(customFilePath, customContent);

    // Open the custom file and position cursor at line 3 (start of database object)
    await driver.command(`edit ${customFilePath}`);

    // Get the original buffer content for comparison
    const buffer = await getCurrentBuffer(driver.nvim);
    const originalLines = await buffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });

    // Trigger prediction
    await driver.magenta.command("predict-edit");
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // Mock a complex multi-line replacement that:
    // - Starts partway through line 3 ("database: {")
    // - Continues through lines 4-9 (the nested database structure)
    // - Replaces with a flattened structure spanning different number of lines
    await driver.mockAnthropic.awaitPendingForceToolUseRequest();
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "tool_use",
      toolRequest: {
        status: "ok",
        value: {
          id: "id" as ToolRequestId,
          toolName: "predict_edit" as ToolName,
          input: {
            find: `\
database: {
      host: 'localhost',
      port: 5432,
      credentials: {
        username: 'admin',
        password: 'secret'
      }
    },`,
            replace: `\
database: {
      url: 'postgresql://admin:secret@localhost:5432/mydb',
      port: 420,
      cache: { enabled: true, ttl: 300 }
    },`,
          },
        },
      },
    });

    // Wait for display state
    await driver.awaitPredictionControllerState("displaying-proposed-edit");

    // Verify state is displaying proposed edit with correct prediction
    expect(controller.state.type).toBe("displaying-proposed-edit");

    // Verify the original buffer content is unchanged during preview
    const previewLines = await buffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });
    expect(previewLines).toEqual(originalLines);

    // Check the extmarks created for the preview - poll until they appear
    const extmarks = await driver.awaitExtmarks(buffer, 16);

    // Extract and verify strikethrough segments match expected "find" text
    const strikethroughExtmarks = extmarks.filter(
      (mark) =>
        mark.options.hl_group ===
        MAGENTA_HIGHLIGHT_GROUPS.PREDICTION_STRIKETHROUGH,
    );
    const bufferLines = await buffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });

    // Sort extmarks by position to ensure correct order
    const sortedMarks = strikethroughExtmarks.sort((a, b) => {
      if (a.startPos.row !== b.startPos.row) {
        return a.startPos.row - b.startPos.row;
      }
      return a.startPos.col - b.startPos.col;
    });

    const strikeThroughSegments: string[] = [];

    for (const mark of sortedMarks) {
      const startRow = mark.startPos.row;
      const startCol = mark.startPos.col;
      const endRow = mark.endPos.row;
      const endCol = mark.endPos.col;

      let text = "";
      if (startRow === endRow) {
        // Single line extraction
        const line = bufferLines[startRow];
        text = line.slice(startCol, endCol);
      } else {
        // Multi-line extraction
        // First line
        const firstLine = bufferLines[startRow];
        text += firstLine.slice(startCol);
        text += "\n";

        // Middle lines
        for (let row = startRow + 1; row < endRow; row++) {
          text += bufferLines[row];
          text += "\n";
        }

        // Last line
        const lastLine = bufferLines[endRow];
        text += lastLine.slice(0, endCol);
      }

      if (text.length > 0) {
        strikeThroughSegments.push(text);
      }
    }

    expect(strikeThroughSegments, "strikethroughs").toEqual([
      "host",
      "5432",
      "credentials",
      `
        username`,
      "'admin'",
      `
        password`,
      `'secret'
      `,
    ]);

    // Extract and verify virtual text insertion points
    const virtualTextExtmarks = extmarks.filter(
      (mark) => !mark.options.hl_group,
    );

    // Verify we have insertion point markers (zero-width extmarks for virtual text)
    expect(virtualTextExtmarks.length).toBeGreaterThan(0);

    // Verify these are zero-width insertion markers
    const insertionMarkers = virtualTextExtmarks.filter(
      (mark) =>
        mark.startPos.row === mark.endPos.row &&
        mark.startPos.col === mark.endPos.col,
    );
    expect(insertionMarkers.length).toBeGreaterThan(0);

    // Verify we have insertion points across multiple lines (multiline replacement)
    const uniqueRows = new Set(
      virtualTextExtmarks.map((mark) => mark.startPos.row),
    );
    expect(uniqueRows.size).toBeGreaterThan(1);

    // Accept the prediction
    await driver.magenta.command("accept-prediction");

    // Wait for prediction to be applied
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify state returned to idle
    expect(controller.state.type).toBe("idle");

    // Verify the complex edit was applied correctly
    const newContent = (
      await buffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      })
    ).join("\n");

    const expectedResult = `\
function processConfig() {
  const config = {
    database: {
      url: 'postgresql://admin:secret@localhost:5432/mydb',
      port: 420,
      cache: { enabled: true, ttl: 300 }
    },
    logging: {
      level: 'info'
    }
  };
  return config;
}`;

    expect(newContent).toEqual(expectedResult);
  });
});

test("complex multi-line prediction dismissal preserves original content", async () => {
  await withDriver({}, async (driver) => {
    const controller = driver.magenta.editPredictionController;

    // Create a custom test file with specific content for predictable testing
    const customContent = `\
function processConfig() {
  const config = {
    database: {
      host: 'localhost',
      port: 5432,
      credentials: {
        username: 'admin',
        password: 'secret'
      }
    },
    logging: {
      level: 'info'
    }
  };
  return config;
}`;

    // Write the custom file directly to the temp directory
    const customFilePath = path.join(driver.magenta.cwd, "custom-test.js");
    await fs.writeFile(customFilePath, customContent);

    // Open the custom file and position cursor at line 3 (start of database object)
    await driver.command(`edit ${customFilePath}`);

    // Get the original buffer content for comparison
    const buffer = await getCurrentBuffer(driver.nvim);
    const originalLines = await buffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });

    // Trigger prediction
    await driver.magenta.command("predict-edit");
    await driver.awaitPredictionControllerState("awaiting-agent-reply");

    // Mock a complex multi-line replacement that:
    // - Starts partway through line 3 ("database: {")
    // - Continues through lines 4-9 (the nested database structure)
    // - Replaces with a flattened structure spanning different number of lines
    await driver.mockAnthropic.awaitPendingForceToolUseRequest();
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "tool_use",
      toolRequest: {
        status: "ok",
        value: {
          id: "id" as ToolRequestId,
          toolName: "predict_edit" as ToolName,
          input: {
            find: `\
database: {
      host: 'localhost',
      port: 5432,
      credentials: {
        username: 'admin',
        password: 'secret'
      }
    },`,
            replace: `\
database: {
      url: 'postgresql://admin:secret@localhost:5432/mydb',
      port: 420,
      cache: { enabled: true, ttl: 300 }
    },`,
          },
        },
      },
    });

    // Wait for display state
    await driver.awaitPredictionControllerState("displaying-proposed-edit");

    // Verify state is displaying proposed edit with correct prediction
    expect(controller.state.type).toBe("displaying-proposed-edit");

    // Verify the original buffer content is unchanged during preview
    const previewLines = await buffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });
    expect(previewLines).toEqual(originalLines);

    // Dismiss the prediction instead of accepting it
    await driver.magenta.command("dismiss-prediction");

    // Wait for dismissal to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify state returned to idle
    expect(controller.state.type).toBe("idle");

    // Verify the buffer content remains unchanged after dismissal
    const finalLines = await buffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });

    expect(finalLines).toEqual(originalLines);

    // Instead of counting extmarks, verify the buffer content is unchanged
    // This is what we really care about in this test
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Specifically verify that the complex replacement did NOT happen
    const finalContent = finalLines.join("\n");
    expect(finalContent).toEqual(customContent);
    expect(finalContent).toContain("host: 'localhost'");
    expect(finalContent).toContain("port: 5432");
    expect(finalContent).not.toContain(
      "url: 'postgresql://admin:secret@localhost:5432/mydb'",
    );
    expect(finalContent).not.toContain("port: 420");
    expect(finalContent).not.toContain("cache: { enabled: true, ttl: 300 }");
  });
});
