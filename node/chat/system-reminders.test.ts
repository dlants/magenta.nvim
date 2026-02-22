import { test, expect } from "vitest";
import { withDriver } from "../test/preamble.ts";
import type { ToolName, ToolRequestId } from "../tools/types.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { MockProvider } from "../providers/mock.ts";

type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
type TextBlockParam = Anthropic.Messages.TextBlockParam;

// System reminders are converted to text blocks with <system-reminder> tags
// when sent to Anthropic, so we search for text blocks containing that tag
function findSystemReminderText(
  content: string | ContentBlockParam[],
): TextBlockParam | undefined {
  if (typeof content === "string") return undefined;
  return content.find(
    (c): c is TextBlockParam =>
      c.type === "text" && c.text.includes("<system-reminder>"),
  );
}

test("user-submitted messages should include system reminder", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Send a user message
    await driver.inputMagentaText("Hello");
    await driver.send();

    // Get the request
    const request = await driver.mockAnthropic.awaitPendingStream();

    // Check the last message (user message) has system reminder
    const userMessage = request.messages[request.messages.length - 1];
    expect(userMessage.role).toBe("user");

    // Find system reminder in content (converted to text block with <system-reminder> tag)
    const systemReminder = findSystemReminderText(userMessage.content);
    expect(systemReminder).toBeDefined();

    if (systemReminder) {
      expect(systemReminder.text).toContain("<system-reminder>");
      expect(systemReminder.text).toContain("Remember the skills");
    }
  });
});

test("auto-respond messages should include system reminder after tool result", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Send a user message
    await driver.inputMagentaText("Use a tool");
    await driver.send();

    // Get the request
    const request = await driver.mockAnthropic.awaitPendingStream();

    // Respond with a tool use
    request.respond({
      stopReason: "tool_use",
      text: "I'll use get_file",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool_1" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: { filePath: "./poem.txt" },
          },
        },
      ],
    });

    // Wait for the auto-respond (tool result message)
    const autoRespondRequest = await driver.mockAnthropic.awaitPendingStream();

    // Find the tool result message (may not be the last message now)
    const toolResultMessage = MockProvider.findLastToolResultMessage(
      autoRespondRequest.messages,
    );
    expect(toolResultMessage).toBeDefined();
    expect(toolResultMessage!.role).toBe("user");

    // Tool result message should NOT have a system reminder
    const toolResultReminder = findSystemReminderText(
      toolResultMessage!.content,
    );
    expect(toolResultReminder).toBeUndefined();

    // The last message should be a separate user message with the system reminder
    const lastMessage =
      autoRespondRequest.messages[autoRespondRequest.messages.length - 1];
    expect(lastMessage.role).toBe("user");

    const systemReminder = findSystemReminderText(lastMessage.content);
    expect(systemReminder).toBeDefined();
    expect(systemReminder!.text).toContain("<system-reminder>");
  });
});

test("auto-respond skips system reminder when output tokens are below threshold", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Send a user message (always includes reminder, resets counter)
    await driver.inputMagentaText("Use a tool");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();

    // Respond with tool use but LOW output tokens (below 2000 threshold)
    request.respond({
      stopReason: "tool_use",
      text: "I'll use get_file",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool_1" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: { filePath: "./poem.txt" },
          },
        },
      ],
      usage: { inputTokens: 100, outputTokens: 100 },
    });

    // Wait for the auto-respond
    const autoRespondRequest = await driver.mockAnthropic.awaitPendingStream();

    // The last message should NOT contain a system reminder since
    // only 100 output tokens were generated (below 2000 threshold)
    const lastMessage =
      autoRespondRequest.messages[autoRespondRequest.messages.length - 1];
    expect(lastMessage.role).toBe("user");

    const systemReminder = findSystemReminderText(lastMessage.content);
    expect(systemReminder).toBeUndefined();
  });
});

test("auto-respond includes system reminder after accumulating enough output tokens", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Send a user message (always includes reminder, resets counter)
    await driver.inputMagentaText("Use tools");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();

    // First tool-use response with LOW tokens (100 < 2000)
    request.respond({
      stopReason: "tool_use",
      text: "I'll use get_file",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool_1" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: { filePath: "./poem.txt" },
          },
        },
      ],
      usage: { inputTokens: 100, outputTokens: 100 },
    });

    // Auto-respond (no reminder - 100 tokens < 2000 threshold)
    const autoRespondRequest1 = await driver.mockAnthropic.awaitPendingStream();

    // Second tool-use response with enough tokens to cross threshold
    // cumulative: 100 + 2500 = 2600 >= 2000
    autoRespondRequest1.respond({
      stopReason: "tool_use",
      text: "I'll use another tool",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool_2" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: { filePath: "./poem.txt" },
          },
        },
      ],
      usage: { inputTokens: 100, outputTokens: 2500 },
    });

    // Auto-respond (should include reminder - 2600 >= 2000)
    const autoRespondRequest2 = await driver.mockAnthropic.awaitPendingStream();

    const lastMessage =
      autoRespondRequest2.messages[autoRespondRequest2.messages.length - 1];
    expect(lastMessage.role).toBe("user");

    const systemReminder = findSystemReminderText(lastMessage.content);
    expect(systemReminder).toBeDefined();
    expect(systemReminder!.text).toContain("<system-reminder>");
  });
});
test("root thread should get base reminder", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("Hello");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    const userMessage = request.messages[request.messages.length - 1];

    const systemReminder = findSystemReminderText(userMessage.content);

    expect(systemReminder).toBeDefined();
    expect(systemReminder!.text).toContain("Remember the skills");
    // Root thread should NOT have yield_to_parent reminder
    expect(systemReminder!.text).not.toContain("yield_to_parent");
    expect(systemReminder!.text).not.toContain("notes/");
    expect(systemReminder!.text).not.toContain("plans/");
  });
});

test("system reminder should be collapsed by default in UI", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("Hello");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "end_turn",
      text: "Response",
      toolRequests: [],
    });

    // Check that the collapsed reminder is shown
    await driver.assertDisplayBufferContains("📋 [System Reminder]");

    // Check that the full text is NOT shown initially
    const displayBuffer = await driver.getDisplayBufferText();
    expect(displayBuffer).not.toContain("Remember the skills");
  });
});

test("system reminder is rendered in UI", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("Hello");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({
      stopReason: "end_turn",
      text: "Response",
      toolRequests: [],
    });

    // Verify the system reminder is displayed in the UI
    await driver.assertDisplayBufferContains("📋 [System Reminder]");
  });
});

test("system reminder content appears after context updates", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Add a file to context
    await driver.magenta.command("add-file ./poem.txt");

    // Send a user message
    await driver.inputMagentaText("Hello");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    const userMessage = request.messages[request.messages.length - 1];

    expect(userMessage.role).toBe("user");

    const content = userMessage.content;
    if (typeof content === "string") {
      throw new Error("Expected array content");
    }

    // Find context update (first text block) and system reminder
    const contextUpdate = content.find(
      (c): c is TextBlockParam =>
        c.type === "text" && !c.text.includes("<system-reminder>"),
    );
    const systemReminder = findSystemReminderText(content);

    expect(contextUpdate).toBeDefined();
    expect(systemReminder).toBeDefined();

    // System reminder should come after context update
    const contextIdx = content.indexOf(contextUpdate!);
    const reminderIdx = content.indexOf(systemReminder!);
    expect(reminderIdx).toBeGreaterThan(contextIdx);
  });
});

test("multiple user messages each get their own system reminder", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // First message
    await driver.inputMagentaText("First message");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();
    const userMessage1 = request1.messages[request1.messages.length - 1];
    const reminder1 = findSystemReminderText(userMessage1.content);
    expect(reminder1).toBeDefined();

    request1.respond({
      stopReason: "end_turn",
      text: "Response 1",
      toolRequests: [],
    });

    // Second message
    await driver.inputMagentaText("Second message");
    await driver.send();

    const request2 = await driver.mockAnthropic.awaitPendingStream();
    const userMessage2 = request2.messages[request2.messages.length - 1];
    const reminder2 = findSystemReminderText(userMessage2.content);
    expect(reminder2).toBeDefined();
  });
});
