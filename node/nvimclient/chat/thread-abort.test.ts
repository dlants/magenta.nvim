import type { ToolName, ToolRequestId } from "@magenta/server";
import { expect, it } from "vitest";
import type { Row0Indexed } from "../nvim/window.ts";
import { withDriver } from "../test/preamble.ts";
import { delay, pollUntil } from "../utils/async.ts";

it("clears pending file permission checks when aborting", async () => {
  await withDriver({}, async (driver) => {
    driver.mockSandbox.setState({ status: "unsupported", reason: "disabled" });
    await driver.showSidebar();
    await driver.inputMagentaText("Run a command");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();
    const toolRequestId = "bash-tool" as ToolRequestId;

    // Respond with bash_command tool use - this will block on user approval (sandbox disabled)
    request1.respond({
      stopReason: "tool_use",
      text: "I'll run the command.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "bash_command" as ToolName,
            input: { command: "cat .secret" },
          },
        },
      ],
    });

    // Wait for approval dialog to appear
    await driver.assertDisplayBufferContains("May I run command");

    const thread = driver.magenta.chat.getActiveThread();

    // Verify we have a pending permission
    expect(thread.sandboxViolationHandler!.getPendingViolations().size).toBe(1);

    // Abort the thread
    await driver.abort();
    await delay(0);

    // Verify pending permissions are cleared
    expect(thread.sandboxViolationHandler!.getPendingViolations().size).toBe(0);

    // Verify the approval dialog is no longer displayed
    await driver.assertDisplayBufferDoesNotContain("May I run command");
  });
});

it("clears pending permissions when sending a new message during tool_use", async () => {
  await withDriver({}, async (driver) => {
    driver.mockSandbox.setState({ status: "unsupported", reason: "disabled" });
    await driver.showSidebar();
    await driver.inputMagentaText("Run a command");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();

    // Respond with bash_command tool use - this will block on user approval (sandbox disabled)
    request1.respond({
      stopReason: "tool_use",
      text: "I'll run the command.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "bash-tool" as ToolRequestId,
            toolName: "bash_command" as ToolName,
            input: { command: "cat .secret" },
          },
        },
      ],
    });

    // Wait for approval dialog to appear
    await driver.assertDisplayBufferContains("May I run command");

    const thread = driver.magenta.chat.getActiveThread();

    // Verify we have a pending permission
    expect(thread.sandboxViolationHandler!.getPendingViolations().size).toBe(1);

    // Send a new message instead of explicitly aborting — this triggers
    // an implicit abort via handleSendMessageRequest
    await driver.inputMagentaText("Never mind, do something else");
    await driver.send();

    // The implicit abort should clear pending permissions
    await pollUntil(
      () => thread.sandboxViolationHandler!.getPendingViolations().size === 0,
      { timeout: 2000, message: "waiting for pending permissions to clear" },
    );

    // Verify the approval dialog is no longer displayed
    await driver.assertDisplayBufferDoesNotContain("May I run command");

    // Handle the second request to confirm flow continues
    const request2 = await driver.mockAnthropic.awaitPendingStream();
    request2.respond({
      stopReason: "end_turn",
      text: "Ok, doing something else.",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("Ok, doing something else.");
  });
});
it("appends pending messages to input buffer on abort", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("First message");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();

    // Queue an @async message while the first request is in flight
    await driver.inputMagentaText("@async Queued pending message");
    await driver.send();

    const thread = driver.magenta.chat.getActiveThread();
    expect(thread.thread.queued.async).toHaveLength(1);

    // Type some in-progress text into the input buffer
    await driver.inputMagentaText("In progress typing");

    // Abort the in-flight turn
    await driver.abort();

    // Respond to the aborted request - should be ignored
    request1.respond({
      stopReason: "end_turn",
      text: "ignored",
      toolRequests: [],
    });

    await pollUntil(async () => {
      const lines = await driver.getInputBuffer().getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      const content = lines.join("\n");
      if (!content.includes("Queued pending message")) {
        throw new Error(`pending text not appended yet: ${content}`);
      }
      if (!content.includes("In progress typing")) {
        throw new Error(`existing text was clobbered: ${content}`);
      }
    });

    // Queue must be empty after abort
    expect(thread.thread.queued.async).toHaveLength(0);
  });
});

it("recovers pending messages into empty input buffer on abort", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("First message");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();

    // Queue an @async message while the first request is in flight
    await driver.inputMagentaText("@async Queued pending message");
    await driver.send();

    const thread = driver.magenta.chat.getActiveThread();
    expect(thread.thread.queued.async).toHaveLength(1);

    // Do not type anything into the input buffer; abort with an empty buffer
    await driver.abort();

    request1.respond({
      stopReason: "end_turn",
      text: "ignored",
      toolRequests: [],
    });

    await pollUntil(async () => {
      const lines = await driver.getInputBuffer().getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      // The pending text should replace the empty placeholder line with no
      // stray leading blank line.
      if (lines[0] !== "Queued pending message") {
        throw new Error(
          `expected pending text on the first line, got: ${JSON.stringify(lines)}`,
        );
      }
    });

    expect(thread.thread.queued.async).toHaveLength(0);
  });
});
