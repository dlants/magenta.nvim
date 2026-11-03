import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/server";
import { expect, test } from "vitest";
import type { NvimDriver } from "../test/driver.ts";
import { withDriver } from "../test/preamble.ts";

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
