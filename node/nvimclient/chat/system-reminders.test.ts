import * as fs from "node:fs/promises";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolName, ToolRequestId } from "@magenta/server";
import { expect, test } from "vitest";
import type { NvimDriver } from "../test/driver.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

/** After the opening request, the standing reminder fires every
 * SYSTEM_REMINDER_MIN_TOKEN_INTERVAL output tokens. Drive a full turn first to
 * arm the gate for whatever is sent next. */
async function armStandingReminder(driver: NvimDriver): Promise<void> {
  await driver.inputMagentaText("warm up");
  await driver.send();
  const request = await driver.mockAnthropic.awaitPendingStream();
  request.respond({
    stopReason: "end_turn",
    text: "warmed up",
    toolRequests: [],
    usage: { inputTokens: 10, outputTokens: 5000 },
  });
}

const _SKILL_WITH_REMINDER =
  "# Skill\n\n<system_reminder>\nalways pet the cat\n</system_reminder>\n";

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

test("system reminder should be collapsed by default in UI", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await armStandingReminder(driver);

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
    await armStandingReminder(driver);

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

test("auto-respond combines the standing and bash reminders into a single system_reminder block", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("Run a long command");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();

    // 15000 X's exceeds the 8000-char abbreviation budget so wasAbbreviated=true,
    // setting `pendingBashReminder` for the next stream.
    const longArg = "X".repeat(15000);

    request.respond({
      stopReason: "tool_use",
      text: "I'll run that command",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool_long" as ToolRequestId,
            toolName: "bash_command" as ToolName,
            input: { command: `echo "${longArg}"` },
          },
        },
      ],
      // 5000 outputTokens >= SYSTEM_REMINDER_MIN_TOKEN_INTERVAL fires the standing gate.
      usage: { inputTokens: 1000, outputTokens: 5000 },
    });

    const autoRespondRequest = await driver.mockAnthropic.awaitPendingStream();

    const lastMessage =
      autoRespondRequest.messages[autoRespondRequest.messages.length - 1];
    expect(lastMessage.role).toBe("user");
    if (typeof lastMessage.content === "string") {
      throw new Error("Expected array content");
    }

    const reminderBlocks = lastMessage.content.filter(
      (c): c is TextBlockParam =>
        c.type === "text" && c.text.includes("<system-reminder>"),
    );
    expect(reminderBlocks.length).toBe(1);
    const combinedText = reminderBlocks[0].text;
    expect((combinedText.match(/<system-reminder>/g) ?? []).length).toBe(1);
    expect(combinedText).toContain("Remember the skills");
    expect(combinedText).toContain("bash_summarizer");

    autoRespondRequest.respond({
      stopReason: "end_turn",
      text: "Done",
      toolRequests: [],
    });

    // The combined reminder renders as a single collapsed header, alongside
    // the one the thread's opening request carried.
    await pollUntil(async () => {
      const displayText = await driver.getDisplayBufferText();
      const headerCount = (displayText.match(/📋 \[System Reminder\]/g) ?? [])
        .length;
      if (headerCount !== 2) {
        throw new Error(`expected 2 reminder headers, got ${headerCount}`);
      }
    });
  });
});

test("a message containing only context updates and reminders gets no user header", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.magenta.command("context-files ./poem.txt");
    await driver.inputMagentaText("Use a tool");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();
    // Low output tokens, so the auto-respond turn carries no system reminder
    // and the message is composed solely of a tool result + context update.
    request.respond({
      stopReason: "tool_use",
      text: "I'll use get_file",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool_1" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: { files: [{ filePath: "./poem.txt" }] },
          },
        },
      ],
      usage: { inputTokens: 100, outputTokens: 100 },
    });

    await fs.writeFile(path.join(driver.magenta.cwd, "poem.txt"), "changed\n");

    const autoRespondRequest = await driver.mockAnthropic.awaitPendingStream();
    autoRespondRequest.respond({
      stopReason: "end_turn",
      text: "Done",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("Done");
    const displayText = await driver.getDisplayBufferText();
    const userHeaders = displayText.match(/^# user:$/gm) ?? [];
    expect(userHeaders.length).toBe(1);
  });
});

test("a user message that mentions tag names still renders as user text", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(
      "I see <context_update> and <system-reminder> blocks as plain text",
    );
    await driver.send();
    const request = await driver.mockAnthropic.awaitPendingStream();
    request.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
    await driver.assertDisplayBufferContains("ok");
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains(
      "I see <context_update> and <system-reminder> blocks as plain text",
    );
  });
});

test("@implementplan activates a persistent plan-maintenance reminder", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("@implementplan");
    await driver.send();

    const request = await driver.mockAnthropic.awaitPendingStream();

    // The reminder rides the next request the token gate lets through, not the
    // opening one.
    request.respond({
      stopReason: "tool_use",
      text: "Implementing",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool_1" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: { files: [{ filePath: "./poem.txt" }] },
          },
        },
      ],
      usage: { inputTokens: 100, outputTokens: 5000 },
    });

    const autoRespondRequest = await driver.mockAnthropic.awaitPendingStream();
    const lastMessage =
      autoRespondRequest.messages[autoRespondRequest.messages.length - 1];
    const followupReminder = findSystemReminderText(lastMessage.content);
    expect(followupReminder).toBeDefined();
    expect(followupReminder!.text).toContain("keep the plan file updated");
  });
});
