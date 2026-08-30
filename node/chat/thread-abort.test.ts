import type { ToolName, ToolRequestId } from "@magenta/core";
import { expect, it } from "vitest";
import type { Row0Indexed } from "../nvim/window.ts";
import { withDriver } from "../test/preamble.ts";
import { sanitizeMessagesForSnapshot } from "../test/sanitize-snapshot.ts";
import { delay, pollUntil } from "../utils/async.ts";

it("forks a thread while streaming without aborting source", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Start a conversation with one completed exchange
    await driver.inputMagentaText("What is 2+2?");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();
    request1.respond({
      stopReason: "end_turn",
      text: "2+2 equals 4.",
      toolRequests: [],
    });

    // Start a second request that will be streaming when we fork
    await driver.inputMagentaText("What about 3+3?");
    await driver.send();

    const streamingRequest = await driver.mockAnthropic.awaitPendingStream();
    const originalThreadId = driver.magenta.chat.state.activeThreadId;
    const originalThread = driver.magenta.chat.getActiveThread();

    // Fork by pressing F on the prior assistant message ("2+2 equals 4.")
    await driver.pressOnDisplayMessage("2+2 equals 4.", "F");

    // Per the plan, fork no longer aborts the source. Confirm the streaming
    // request is still live and the source agent is still streaming.
    expect(streamingRequest.aborted).toBe(false);
    expect(originalThread.agent.phase.type).toBe("streaming");

    // Wait for the new thread to become active
    await pollUntil(() => {
      if (driver.magenta.chat.state.activeThreadId === originalThreadId) {
        throw new Error("Still on original thread");
      }
    });

    // Type a follow-up message in the forked thread.
    await driver.inputMagentaText("Actually, tell me about 5+5");
    await driver.send();

    // A new thread should be created and receive the forked message.
    // The source thread is still streaming (fork no longer aborts it), so
    // match the forked stream explicitly by its follow-up message text.
    const forkedStream = await driver.mockAnthropic.awaitPendingStreamWithText(
      "Actually, tell me about 5+5",
      { message: "forked thread request" },
    );

    expect(
      sanitizeMessagesForSnapshot(forkedStream.messages),
    ).toMatchSnapshot();

    // Verify the new thread is active
    const newThread = driver.magenta.chat.getActiveThread();
    expect(newThread.id).not.toBe(originalThreadId);

    // Allow the original streaming request to complete cleanly.
    streamingRequest.respond({
      stopReason: "end_turn",
      text: "3+3 equals 6.",
      toolRequests: [],
    });
  });
});

it("forks a thread while waiting for tool use without aborting source", async () => {
  await withDriver({}, async (driver) => {
    driver.mockSandbox.setState({ status: "unsupported", reason: "disabled" });
    await driver.showSidebar();

    // Start a conversation
    await driver.inputMagentaText("Read my secret file");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();

    // Respond with bash_command tool use - this will block on user approval (sandbox disabled)
    request1.respond({
      stopReason: "tool_use",
      text: "I'll read your secret file.",
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

    // Wait for approval dialog - we're now stopped waiting for tool use
    await driver.assertDisplayBufferContains("May I run command");

    const originalThread = driver.magenta.chat.getActiveThread();
    const originalThreadId = originalThread.id;

    // Verify we're in tool_use mode
    expect(originalThread.core.state.mode.type).toBe("tool_use");

    // Fork by pressing F on the assistant's tool-use message text.
    await driver.pressOnDisplayMessage("I'll read your secret file.", "F");

    // Wait for the new thread to become active
    await pollUntil(() => {
      if (driver.magenta.chat.state.activeThreadId === originalThreadId) {
        throw new Error("Still on original thread");
      }
    });

    // Type a follow-up message and send it.
    await driver.inputMagentaText("Do something else instead");
    await driver.send();

    // The fork's cloned messages convert the pending tool_use into an error
    // tool_result via cleanupClonedMessages — without aborting the source.
    const forkedStream = await driver.mockAnthropic.awaitPendingStream({
      message: "forked thread request",
    });

    expect(
      sanitizeMessagesForSnapshot(forkedStream.messages),
    ).toMatchSnapshot();

    // Verify the new thread is active
    const newThread = driver.magenta.chat.getActiveThread();
    expect(newThread.id).not.toBe(originalThreadId);

    // Per the plan, fork no longer aborts the source. The original thread
    // is still in tool_use mode awaiting approval.
    expect(originalThread.core.state.mode.type).toBe("tool_use");
    expect(originalThread.agent.phase.type).toBe("running_tools");
  });
});

it("aborts request when sending new message while waiting for response", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("First message");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();

    // Send a second message before the first request responds
    await driver.inputMagentaText("Second message while first is pending");
    await driver.send();

    // The first request should be aborted
    expect(request1.aborted).toBe(true);

    // Respond to the aborted request - this should be ignored
    request1.respond({
      stopReason: "end_turn",
      text: "This response should be ignored because request was aborted",
      toolRequests: [],
    });

    // Handle the second request
    const request2 = await driver.mockAnthropic.awaitPendingStream();
    request2.respond({
      stopReason: "end_turn",
      text: "Second response that should be shown",
      toolRequests: [],
    });

    // Verify that only the second message and response are displayed
    await driver.assertDisplayBufferContains(
      "Second message while first is pending",
    );
    await driver.assertDisplayBufferContains(
      "Second response that should be shown",
    );

    // Verify the aborted response is NOT displayed
    const bufferContent = await driver.getDisplayBufferText();
    expect(bufferContent).not.toContain(
      "This response should be ignored because request was aborted",
    );

    // Check the thread message structure - should only have the second exchange
    const thread = driver.magenta.chat.getActiveThread();
    const messages = thread.getMessages();
    expect(sanitizeMessagesForSnapshot(messages)).toMatchSnapshot();
  });
});

it("aborts tool use when sending new message while tool is executing", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Run a slow command");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();
    const toolRequestId = "slow-bash-command" as ToolRequestId;

    // Respond with a tool use that would normally take time
    request1.respond({
      stopReason: "tool_use",
      text: "I'll run a slow bash command for you.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "bash_command" as ToolName,
            input: { command: "sleep 5 && echo 'This should be aborted'" },
          },
        },
      ],
    });

    // Wait for the tool execution to start
    await driver.assertDisplayBufferContains(
      "I'll run a slow bash command for you.",
    );

    // Send a new message while the tool is executing
    await driver.inputMagentaText("Cancel that, run something else");
    await driver.send();

    // Handle the second request
    await driver.mockAnthropic.awaitPendingStream();
    // Verify that the second exchange is displayed
    await driver.assertDisplayBufferContains("Cancel that, run something else");

    // Verify the aborted tool output is NOT displayed
    const bufferContent = await driver.getDisplayBufferText();
    expect(bufferContent).toContain("❌ Request was aborted by the user.");

    // Check the thread message structure
    const thread = driver.magenta.chat.getActiveThread();
    const messages = thread.getMessages();
    expect(sanitizeMessagesForSnapshot(messages)).toMatchSnapshot();
  });
});

it("inserts error tool results when aborting while stopped waiting for tool use", async () => {
  await withDriver({}, async (driver) => {
    driver.mockSandbox.setState({ status: "unsupported", reason: "disabled" });
    await driver.showSidebar();
    await driver.inputMagentaText("Read my secret file");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();
    const toolRequestId = "bash-tool" as ToolRequestId;

    // Respond with bash_command tool use - this will block on user approval (sandbox disabled)
    request1.respond({
      stopReason: "tool_use",
      text: "I'll read your secret file.",
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

    // Wait for approval dialog to appear - we're now stopped waiting for tool use
    await driver.assertDisplayBufferContains("May I run command");

    // Send a new message to abort - this should insert error tool result
    await driver.inputMagentaText("Never mind, do something else");
    await driver.send();

    // Handle the second request
    const request2 = await driver.mockAnthropic.awaitPendingStream();

    // Verify the message structure includes an error tool_result for the aborted tool
    const messagePattern = request2.messages.flatMap((m) =>
      typeof m.content === "string"
        ? "stringmessage"
        : m.content.map((c) => `${m.role}:${c.type}`),
    );

    expect(messagePattern).toEqual([
      "user:text",
      "user:text", // system_reminder
      "user:text", // system_info
      "assistant:text",
      "assistant:tool_use",
      "user:tool_result", // error tool result from abort
      "user:text", // abort notification
      "user:text",
      "user:text", // system_reminder
    ]);

    // Verify the tool result contains the abort error message
    const userMessages = request2.messages.filter((m) => m.role === "user");
    const toolResultMessage = userMessages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((c) => c.type === "tool_result"),
    );
    expect(toolResultMessage).toBeDefined();

    const toolResultContent = (
      toolResultMessage!.content as Array<{ type: string }>
    ).find((c) => c.type === "tool_result") as {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error: boolean;
    };
    expect(toolResultContent.tool_use_id).toBe(toolRequestId);
    expect(toolResultContent.is_error).toBe(true);
    expect(toolResultContent.content).toContain("aborted by the user");
  });
});

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
    expect(thread.core.queued.async).toHaveLength(1);

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
    expect(thread.core.queued.async).toHaveLength(0);
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
    expect(thread.core.queued.async).toHaveLength(1);

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

    expect(thread.core.queued.async).toHaveLength(0);
  });
});

it("removes server_tool_use content when aborted before receiving results", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Search for information about TypeScript");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();

    // First send text content
    request1.streamText("I'll search for information about TypeScript.");

    // Then send server tool use streaming events
    request1.streamServerToolUse("web-search-123", "web_search", {
      query: "TypeScript programming language",
    });

    // Wait for the server tool use to be displayed
    await driver.assertDisplayBufferContains(
      "I'll search for information about TypeScript.",
    );

    // Verify the server tool use content is in the message before abort
    const thread = driver.magenta.chat.getActiveThread();
    const messages = thread.getProviderMessages();
    const contentTypesBeforeAbort = messages[messages.length - 1].content.map(
      (c) => c.type,
    );
    expect(contentTypesBeforeAbort).toEqual(["text", "server_tool_use"]);

    // Send a new message to abort the current operation before web search result comes back
    await driver.abort();
    await delay(0);

    // The server tool use should be removed since no result was received
    const messagesAfterAbort = thread.getProviderMessages();
    // Last message is the abort notification; check the assistant message before it
    const assistantMessage = messagesAfterAbort.findLast(
      (m) => m.role === "assistant",
    )!;
    const contentTypesAfterAbort = assistantMessage.content.map((c) => c.type);
    expect(contentTypesAfterAbort).toEqual(["text"]);
  });
});
