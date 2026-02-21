import { withDriver } from "../test/preamble.ts";
import { type ToolRequestId } from "../tools/toolManager.ts";
import { expect, it } from "vitest";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { ToolName } from "../tools/types.ts";
import { delay, pollUntil } from "../utils/async.ts";

it("forks a thread while streaming by aborting the stream first", async () => {
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

    // Fork while the request is still streaming
    await driver.inputMagentaText("@fork Actually, tell me about 5+5");
    await driver.send();

    // The streaming request should be aborted
    expect(streamingRequest.aborted).toBe(true);

    // The original thread should now be stopped/aborted
    await pollUntil(
      () => originalThread.agent.getState().status.type === "stopped",
      { timeout: 1000, message: "waiting for agent to be stopped" },
    );
    expect(originalThread.agent.getState().status).toEqual({
      type: "stopped",
      stopReason: "aborted",
    });

    // A new thread should be created and receive the forked message
    const forkedStream = await driver.mockAnthropic.awaitPendingStream({
      message: "forked thread request",
    });

    expect(forkedStream.messages).toMatchSnapshot();

    // Verify the new thread is active
    const newThread = driver.magenta.chat.getActiveThread();
    expect(newThread.id).not.toBe(originalThreadId);
  });
});

it("forks a thread while waiting for tool use by aborting pending tools first", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Start a conversation
    await driver.inputMagentaText("Read my secret file");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();

    // Respond with get_file tool use - this will block on user approval
    request1.respond({
      stopReason: "tool_use",
      text: "I'll read your secret file.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "get-file-tool" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: { filePath: ".secret" as UnresolvedFilePath },
          },
        },
      ],
    });

    // Wait for approval dialog - we're now stopped waiting for tool use
    await driver.assertDisplayBufferContains("👀 .secret");

    const originalThread = driver.magenta.chat.getActiveThread();
    const originalThreadId = originalThread.id;

    // Verify we're in tool_use mode
    expect(originalThread.state.mode.type).toBe("tool_use");

    // Fork the thread while waiting for tool use
    await driver.inputMagentaText("@fork Do something else instead");
    await driver.send();

    // The fork should abort the pending tool use, then clone
    const forkedStream = await driver.mockAnthropic.awaitPendingStream({
      message: "forked thread request",
    });

    // Verify the cloned messages include the error tool result from the abort
    expect(forkedStream.messages).toMatchSnapshot();

    // Verify the new thread is active
    const newThread = driver.magenta.chat.getActiveThread();
    expect(newThread.id).not.toBe(originalThreadId);

    // Verify original thread was aborted
    expect(originalThread.state.mode.type).toBe("normal");
    expect(originalThread.agent.getState().status).toEqual({
      type: "stopped",
      stopReason: "aborted",
    });
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
    expect(messages).toMatchSnapshot();
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
    expect(bufferContent).toContain(
      "'This should be aborted'` - Request was aborted",
    );

    // Check the thread message structure
    const thread = driver.magenta.chat.getActiveThread();
    const messages = thread.getMessages();
    expect(messages).toMatchSnapshot();
  });
});

it("inserts error tool results when aborting while stopped waiting for tool use", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Read my secret file");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();
    const toolRequestId = "get-file-tool" as ToolRequestId;

    // Respond with get_file tool use - this will block on user approval
    request1.respond({
      stopReason: "tool_use",
      text: "I'll read your secret file.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "get_file" as ToolName,
            input: { filePath: ".secret" as UnresolvedFilePath },
          },
        },
      ],
    });

    // Wait for approval dialog to appear - we're now stopped waiting for tool use
    await driver.assertDisplayBufferContains("👀 .secret");

    // Send a new message to abort - this should insert error tool result
    await driver.inputMagentaText("Never mind, do something else");
    await driver.send();

    // Handle the second request
    const request2 = await driver.mockAnthropic.awaitPendingStream();

    // Verify the message structure includes an error tool_result for the aborted tool
    const messagePattern = request2.messages.flatMap((m) =>
      typeof m.content == "string"
        ? "stringmessage"
        : m.content.map((c) => `${m.role}:${c.type}`),
    );

    expect(messagePattern).toEqual([
      "user:text",
      "user:text", // system_reminder
      "assistant:text",
      "assistant:tool_use",
      "user:tool_result", // error tool result from abort
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
    await driver.showSidebar();
    await driver.inputMagentaText("Read my secret file");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();
    const toolRequestId = "get-file-tool" as ToolRequestId;

    // Respond with get_file tool use - this will block on user approval
    request1.respond({
      stopReason: "tool_use",
      text: "I'll read your secret file.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "get_file" as ToolName,
            input: { filePath: ".secret" as UnresolvedFilePath },
          },
        },
      ],
    });

    // Wait for approval dialog to appear
    await driver.assertDisplayBufferContains("👀 .secret");

    const thread = driver.magenta.chat.getActiveThread();

    // Verify we have a pending permission
    expect(thread.permissionFileIO!.getPendingPermissions().size).toBe(1);

    // Abort the thread
    await driver.abort();
    await delay(0);

    // Verify pending permissions are cleared
    expect(thread.permissionFileIO!.getPendingPermissions().size).toBe(0);

    // Verify the approval dialog is no longer displayed
    await driver.assertDisplayBufferDoesNotContain("👀 .secret");
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
    const contentTypesAfterAbort = messagesAfterAbort[
      messagesAfterAbort.length - 1
    ].content.map((c) => c.type);
    expect(contentTypesAfterAbort).toEqual(["text"]);
  });
});
