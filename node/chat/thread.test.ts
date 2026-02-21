import { withDriver } from "../test/preamble.ts";
import { LOGO } from "./thread.ts";
import { type ToolRequestId } from "../tools/toolManager.ts";
import { expect, it } from "vitest";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { ToolName } from "../tools/types.ts";
import { delay, pollUntil } from "../utils/async.ts";
import { getcwd } from "../nvim/nvim.ts";
import { $, within } from "zx";
import type { WebSearchResultBlock } from "@anthropic-ai/sdk/resources.mjs";
import fs from "node:fs";
import * as os from "node:os";
import { resolveFilePath } from "../utils/files.ts";
import type { HomeDir } from "../utils/files.ts";
import lodash from "lodash";

/** Sanitize display buffer text for stable snapshots by removing dynamic content */
function sanitizeDisplayForSnapshot(text: string): string {
  // Replace timing info like "exit code 0 (16ms)" with stable placeholder
  return text.replace(/\((\d+)ms\)/g, "(<timing>ms)");
}

/** Replace dynamic thread IDs and timing info in messages with a placeholder for stable snapshots */
function sanitizeMessagesForSnapshot<T>(messages: T): T {
  let json = JSON.stringify(messages);
  // Replace thread IDs like 019bab33-8c7c-76a9-bc7c-9f94103502c8 with placeholder
  json = json.replace(
    /\/tmp\/magenta\/threads\/[a-f0-9-]+\//g,
    "/tmp/magenta/threads/<thread-id>/",
  );
  // Replace timing info like "exit code 0 (16ms)" with stable placeholder
  json = json.replace(/\((\d+)ms\)/g, "(<timing>ms)");
  return JSON.parse(json) as T;
}

it("chat render and a few updates", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Can you run a simple command for me?");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();
    const toolRequestId = "test-bash-command" as ToolRequestId;

    stream.respond({
      stopReason: "tool_use",
      text: "Sure, let me run a simple bash command for you.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "bash_command" as ToolName,
            input: { command: "echo 'Hello from bash!'" },
          },
        },
      ],
    });

    // Check that the buffer contains the expected content during tool execution
    await driver.assertDisplayBufferContains(
      "Can you run a simple command for me?",
    );
    await driver.assertDisplayBufferContains(
      "Sure, let me run a simple bash command for you.",
    );

    // After the tool executes
    await driver.assertDisplayBufferContains("Hello from bash!");
  });
});

it("new-thread creates fresh thread", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Can you look at my list of buffers?");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();

    stream.respond({
      stopReason: "end_turn",
      text: "Sure, let me use the list_buffers tool.",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains(
      "Can you look at my list of buffers?",
    );
    await driver.assertDisplayBufferContains(
      "Sure, let me use the list_buffers tool.",
    );

    await driver.magenta.command("new-thread");
    await driver.assertDisplayBufferContains(LOGO.split("\n")[0]);
  });
});

it("getMessages correctly interleaves tool requests and responses", async () => {
  await withDriver({}, async (driver) => {
    // Create a more complex conversation with multiple tool uses
    await driver.showSidebar();
    await driver.inputMagentaText("Can you help me with my code?");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();

    const toolRequestId1 = "tool-1" as ToolRequestId;
    const toolRequestId2 = "tool-2" as ToolRequestId;

    // First response with bash_command tool use
    request1.respond({
      stopReason: "tool_use",
      text: "I'll help you. Let me check your project first.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId1,
            toolName: "bash_command" as ToolName,
            input: { command: "echo 'Project files summary'" },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains("Project files summary");

    const request2 = await driver.mockAnthropic.awaitPendingStream();
    request2.respond({
      stopReason: "tool_use",
      text: "Now let me check your project structure.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId2,
            toolName: "bash_command" as ToolName,
            input: { command: "echo 'Project structure summary'" },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains("Project structure summary");

    // Final part of the assistant's response
    const request3 = await driver.mockAnthropic.awaitPendingStream();
    request3.respond({
      stopReason: "end_turn",
      text: "Based on these results, I can help you.",
      toolRequests: [],
    });

    // Verify all parts of the conversation are present
    await driver.assertDisplayBufferContains("Can you help me with my code?");
    await driver.assertDisplayBufferContains(
      "I'll help you. Let me check your project first.",
    );
    await driver.assertDisplayBufferContains(
      "Now let me check your project structure.",
    );
    await driver.assertDisplayBufferContains(
      "Based on these results, I can help you.",
    );

    const thread = driver.magenta.chat.getActiveThread();
    const messages = thread.getMessages();

    expect(messages.length).toBe(8);
    expect(
      messages.flatMap((m) => m.content.map((b) => m.role + ":" + b.type)),
    ).toEqual([
      "user:text",
      "user:system_reminder",
      "assistant:text",
      "assistant:tool_use",
      "user:tool_result",
      "user:system_reminder", // system reminder after first tool response
      "assistant:text",
      "assistant:tool_use",
      "user:tool_result",
      "user:system_reminder", // system reminder after second tool response
      "assistant:text",
    ]);
  });
});

it("handles errors during streaming response", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Test error handling during response");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();

    // Simulate an error during streaming
    const errorMessage = "Simulated error during streaming";
    stream.respondWithError(new Error(errorMessage));

    // Verify the error is handled and displayed to the user
    await driver.assertDisplayBufferContains(
      "Test error handling during response",
    );

    // Verify error message is displayed in the UI
    await driver.assertDisplayBufferContains("Error");
    await driver.assertDisplayBufferContains(errorMessage);
  });
});

it("forks a thread with multiple messages into a new thread", async () => {
  await withDriver({}, async (driver) => {
    // 1. Open the sidebar
    await driver.showSidebar();

    // 2. Create a thread with multiple messages
    await driver.inputMagentaText("What is the capital of France?");
    await driver.send();

    // Wait for the request and respond
    const request1 = await driver.mockAnthropic.awaitPendingStream({
      message: "initial request",
    });
    request1.respond({
      stopReason: "end_turn",
      text: "The capital of France is Paris.",
      toolRequests: [],
    });

    // Add a second message
    await driver.inputMagentaText("What about Germany?");
    await driver.send();

    const request2 = await driver.mockAnthropic.awaitPendingStream({
      message: "followup request",
    });
    request2.respond({
      stopReason: "end_turn",
      text: "The capital of Germany is Berlin.",
      toolRequests: [],
    });

    // Get the original thread ID before forking
    const originalThreadId = driver.magenta.chat.state.activeThreadId;

    // 3. Fork the thread with @fork
    await driver.inputMagentaText("@fork Tell me about Italy");
    await driver.send();

    // 4. The fork should immediately clone and create a new thread
    // The new thread should receive the message without @fork
    const stream = await driver.mockAnthropic.awaitPendingStream({
      message: "forked thread request",
    });

    // Verify the cloned messages are present (from the original thread)
    // Plus the new user message "Tell me about Italy"
    expect(sanitizeMessagesForSnapshot(stream.messages)).toMatchSnapshot(
      "fork-cloned-messages",
    );

    // 5. Respond to the forked thread
    stream.respond({
      stopReason: "end_turn",
      text: "Italy's capital is Rome. It's known for its rich history, art, and cuisine.",
      toolRequests: [],
    });

    // 6. Verify the new thread is now active
    const newThread = driver.magenta.chat.getActiveThread();
    expect(newThread.id).not.toBe(originalThreadId);

    // 7. Verify the display shows the forked conversation
    await driver.assertDisplayBufferContains("Tell me about Italy");
    await driver.assertDisplayBufferContains("Italy's capital is Rome");

    // 8. Verify the forked thread has the full conversation history
    const messages = newThread.getMessages();
    expect(messages).toMatchSnapshot("forked-thread-messages");
  });
});

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

it("compact flow: user initiates @compact, spawns compact thread, compacts and continues", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Build up some conversation history
    await driver.inputMagentaText("What is 2+2?");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream({
      message: "initial request",
    });
    request1.respond({
      stopReason: "end_turn",
      text: "2+2 equals 4.",
      toolRequests: [],
    });

    await driver.inputMagentaText("What about 3+3?");
    await driver.send();

    const request2 = await driver.mockAnthropic.awaitPendingStream({
      message: "followup request",
    });
    request2.respond({
      stopReason: "end_turn",
      text: "3+3 equals 6.",
      toolRequests: [],
    });

    const originalThread = driver.magenta.chat.getActiveThread();
    const originalThreadId = originalThread.id;

    // Verify we have conversation history before compacting
    expect(originalThread.getMessages().length).toBeGreaterThanOrEqual(4);

    // User initiates compact with a next prompt
    await driver.inputMagentaText("@compact Now help me with multiplication");
    await driver.send();

    // The compact flow should:
    // 1. Render the thread to markdown
    // 2. Write it to a temp file
    // 3. Spawn a compact subagent thread

    // Wait for the thread to enter compacting mode
    await pollUntil(
      () => {
        if (originalThread.state.mode.type !== "compacting")
          throw new Error(
            `expected compacting mode but got ${originalThread.state.mode.type}`,
          );
      },
      { timeout: 2000, message: "thread should enter compacting mode" },
    );

    // The compact subagent should receive a stream
    const compactSubagentStream = await driver.mockAnthropic.awaitPendingStream(
      {
        message: "compact subagent stream",
      },
    );

    // Verify the compact subagent uses the fast model
    expect(compactSubagentStream.params.model).toBe("mock-fast");
    // Verify the compact subagent received the file contents in its user message
    const subagentMessages = compactSubagentStream.getProviderMessages();
    const userMsg = subagentMessages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const textContent = userMsg!.content
      .filter(
        (c): c is Extract<typeof c, { type: "text" }> => c.type === "text",
      )
      .map((c) => c.text)
      .join("");
    // The subagent should see the rendered thread content
    expect(textContent).toContain("2+2 equals 4");
    expect(textContent).toContain("3+3 equals 6");
    // The subagent should see the user's next prompt for prioritizing retention
    expect(textContent).toContain("Now help me with multiplication");
    expect(textContent).toContain(
      "Prioritize retaining information relevant to this next prompt",
    );

    // Find the temp file path from the subagent's user message
    const tempFileMatch = textContent.match(/The file is at: ([^\n]+)/);
    expect(tempFileMatch).toBeDefined();
    const tempFilePath = tempFileMatch![1];

    // Have the compact subagent use the real EDL tool to edit the temp file
    const edlScript = `file \`${tempFilePath}\`\nselect bof-eof\nreplace <<COMPACT_SUMMARY\n# Summary\nUser asked basic arithmetic: 2+2=4, 3+3=6\nCOMPACT_SUMMARY`;

    compactSubagentStream.respond({
      stopReason: "tool_use",
      text: "I'll compact this conversation.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "edl_1" as ToolRequestId,
            toolName: "edl" as ToolName,
            input: { script: edlScript },
          },
        },
      ],
    });

    // EDL tool auto-executes (no permission needed for /tmp/magenta/ files)
    // After EDL completes, the compact subagent gets a continuation stream
    const afterEdlStream = await driver.mockAnthropic.awaitPendingStream({
      message: "compact subagent after EDL",
    });

    // Verify the EDL tool result was successful
    const afterEdlMessages = afterEdlStream.getProviderMessages();
    const toolResultMsg = afterEdlMessages.find(
      (m) =>
        m.role === "user" && m.content.some((c) => c.type === "tool_result"),
    );
    expect(toolResultMsg).toBeDefined();
    const toolResult = toolResultMsg!.content.find(
      (c) => c.type === "tool_result",
    );
    if (toolResult?.type === "tool_result") {
      expect(toolResult.result.status).toBe("ok");
    }

    afterEdlStream.respond({
      stopReason: "end_turn",
      text: "I have compacted the conversation.",
      toolRequests: [],
    });

    // After the compact subagent stops, the parent thread should:
    // 1. Read back the temp file as the summary
    // 2. Call agent.compact() to replace messages with the summary
    // 3. Auto-respond with the next prompt

    // Wait for the continuation stream on the parent thread
    const afterCompactStream = await driver.mockAnthropic.awaitPendingStream({
      message: "after compact continuation",
    });

    // Verify the compacted thread has reduced messages
    const afterCompactMessages = afterCompactStream.getProviderMessages();

    // After compaction, messages should be minimal:
    // The summary from the temp file + the user's next prompt
    const hasNextPrompt = afterCompactMessages.some(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (c) =>
            c.type === "text" &&
            c.text.includes("Now help me with multiplication"),
        ),
    );
    expect(hasNextPrompt).toBe(true);

    // The original conversation details should be gone (replaced by summary)
    const allText = afterCompactMessages
      .flatMap((m) =>
        m.content
          .filter(
            (c): c is Extract<typeof c, { type: "text" }> => c.type === "text",
          )
          .map((c) => c.text),
      )
      .join("");

    // The EDL-edited summary content should be present in the compacted thread
    expect(allText).toContain("User asked basic arithmetic");
    // Original conversation exchanges should be gone
    expect(allText).not.toContain("What is 2+2?");
    expect(allText).not.toContain("What about 3+3?");

    // Respond to the continuation
    afterCompactStream.respond({
      stopReason: "end_turn",
      text: "Sure! What multiplication would you like help with?",
      toolRequests: [],
    });

    // We should still be on the same thread (compact doesn't create a new root thread)
    expect(driver.magenta.chat.getActiveThread().id).toBe(originalThreadId);

    await driver.assertDisplayBufferContains(
      "What multiplication would you like help with?",
    );
  });
});

it("compact flow without continuation: @compact with no next prompt", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Build up conversation history
    await driver.inputMagentaText("Hello");
    await driver.send();

    const stream1 = await driver.mockAnthropic.awaitPendingStream({
      message: "initial request",
    });
    stream1.respond({
      stopReason: "end_turn",
      text: "Hi there!",
      toolRequests: [],
    });

    const thread = driver.magenta.chat.getActiveThread();

    // User initiates compact with no next prompt
    await driver.inputMagentaText("@compact");
    await driver.send();

    // Wait for compacting mode
    await pollUntil(
      () => {
        if (thread.state.mode.type !== "compacting")
          throw new Error(
            `expected compacting mode but got ${thread.state.mode.type}`,
          );
      },
      { timeout: 2000, message: "thread should enter compacting mode" },
    );

    // Compact subagent receives its stream
    const compactStream = await driver.mockAnthropic.awaitPendingStream({
      message: "compact subagent stream",
    });

    compactStream.respond({
      stopReason: "end_turn",
      text: "Compacted.",
      toolRequests: [],
    });

    // Without a next prompt, the thread should just stop after compaction
    // No continuation stream should be spawned
    await pollUntil(
      () => {
        const agentStatus = thread.agent.getState().status;
        if (agentStatus.type !== "stopped")
          throw new Error(`expected stopped but got ${agentStatus.type}`);
        if (agentStatus.stopReason !== "end_turn")
          throw new Error(
            `expected end_turn but got ${agentStatus.stopReason}`,
          );
      },
      { timeout: 2000, message: "thread should stop after compaction" },
    );

    // Verify messages have been compacted
    const messages = thread.getMessages();
    // Should have the summary as an assistant message
    expect(messages.length).toBeLessThanOrEqual(2);
  });
});

it("compact flow does not process @file commands in subagent or summary", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Build up conversation history that mentions @file
    await driver.inputMagentaText("Tell me about @file:poem.txt usage");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream({
      message: "initial request",
    });
    request1.respond({
      stopReason: "end_turn",
      text: "The @file:poem.txt command adds a file to context.",
      toolRequests: [],
    });

    const thread = driver.magenta.chat.getActiveThread();

    // Compact with a nextPrompt that contains @file:poem.txt
    await driver.inputMagentaText(
      "@compact Now read @file:poem.txt and summarize",
    );
    await driver.send();

    await pollUntil(
      () => {
        if (thread.state.mode.type !== "compacting")
          throw new Error(
            `expected compacting mode but got ${thread.state.mode.type}`,
          );
      },
      { timeout: 2000, message: "thread should enter compacting mode" },
    );

    // 1. Verify the compact subagent does NOT expand @file commands.
    //    The subagent's user message should contain the raw markdown text
    //    including literal "@file:poem.txt" strings, without extra content blocks
    //    from file expansion.
    const compactStream = await driver.mockAnthropic.awaitPendingStream({
      message: "compact subagent stream",
    });

    const subagentMessages = compactStream.getProviderMessages();
    const subagentUserMsg = subagentMessages.find((m) => m.role === "user");
    expect(subagentUserMsg).toBeDefined();

    // The compact subagent should have exactly one text content block (the instructions)
    // If @file were processed, there would be additional content blocks for file contents
    const textBlocks = subagentUserMsg!.content.filter(
      (c) => c.type === "text",
    );
    expect(textBlocks).toHaveLength(1);

    // The raw text should contain the literal @file:poem.txt from the conversation
    const subagentText = textBlocks[0].text;
    expect(subagentText).toContain("@file:poem.txt");

    // Have the compact subagent edit the temp file with a summary that also contains @file
    const tempFileMatch = subagentText.match(/The file is at: ([^\n]+)/);
    expect(tempFileMatch).toBeDefined();
    const tempFilePath = tempFileMatch![1];

    const edlScript = `file \`${tempFilePath}\`\nselect bof-eof\nreplace <<COMPACT_SUMMARY\n# Summary\nUser discussed @file:poem.txt usage. Assistant explained the command.\nCOMPACT_SUMMARY`;

    compactStream.respond({
      stopReason: "tool_use",
      text: "Compacting.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "edl_1" as ToolRequestId,
            toolName: "edl" as ToolName,
            input: { script: edlScript },
          },
        },
      ],
    });

    const afterEdlStream = await driver.mockAnthropic.awaitPendingStream({
      message: "compact subagent after EDL",
    });
    afterEdlStream.respond({
      stopReason: "end_turn",
      text: "Done compacting.",
      toolRequests: [],
    });

    // 2. Verify that after compaction:
    //    - The summary is sent as a raw user message (no command processing)
    //    - The nextPrompt goes through sendMessage, so @file:poem.txt IS expanded
    const afterCompactStream = await driver.mockAnthropic.awaitPendingStream({
      message: "after compact continuation",
    });

    const afterCompactMessages = afterCompactStream.getProviderMessages();

    // Should have two user messages:
    // 1. The raw summary (appendUserMessage)
    // 2. The nextPrompt processed through sendMessage (@file expanded)
    const userMessages = afterCompactMessages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(2);

    // First user message: raw summary (no command processing)
    const summaryContentTypes = userMessages[0].content.map((c) => c.type);
    expect(summaryContentTypes).toEqual(["text"]);
    const summaryText = (
      userMessages[0].content[0] as Extract<
        (typeof userMessages)[0]["content"][0],
        { type: "text" }
      >
    ).text;
    expect(summaryText).toContain("<conversation-summary>");
    expect(summaryText).toContain("@file:poem.txt");

    // Second user message: nextPrompt processed through sendMessage
    // Should have context update from @file expansion + text + system_reminder
    const promptContentTypes = userMessages[1].content.map((c) => c.type);
    expect(promptContentTypes).toContain("text");

    const promptText = userMessages[1].content
      .filter(
        (
          c,
        ): c is Extract<
          (typeof userMessages)[1]["content"][0],
          { type: "text" }
        > => c.type === "text",
      )
      .map((c) => c.text)
      .join("\n");
    expect(promptText).toContain("Now read @file:poem.txt and summarize");

    // The @file:poem.txt in the nextPrompt should have been processed,
    // adding poem.txt to the context manager
    const contextFiles = Object.keys(thread.contextManager.files);
    expect(contextFiles.some((f) => f.includes("poem.txt"))).toBe(true);

    afterCompactStream.respond({
      stopReason: "end_turn",
      text: "Ready to continue.",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("Ready to continue.");
  });
});
it("forks a thread with @compact to clone and compact in one step", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Build up some conversation history
    await driver.inputMagentaText("What is 2+2?");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream({
      message: "initial request",
    });
    request1.respond({
      stopReason: "end_turn",
      text: "2+2 equals 4.",
      toolRequests: [],
    });

    await driver.inputMagentaText("What about 3+3?");
    await driver.send();

    const request2 = await driver.mockAnthropic.awaitPendingStream({
      message: "followup request",
    });
    request2.respond({
      stopReason: "end_turn",
      text: "3+3 equals 6.",
      toolRequests: [],
    });

    const originalThreadId = driver.magenta.chat.state.activeThreadId;

    // Fork with compact - should clone the thread, then process @compact on the forked thread
    await driver.inputMagentaText(
      "@fork @compact Now help me with multiplication",
    );
    await driver.send();

    // The forked thread detects @compact and spawns a compact subagent
    const compactSubagentStream = await driver.mockAnthropic.awaitPendingStream(
      {
        message: "compact subagent in forked thread",
      },
    );

    // Verify the compact subagent sees the original conversation content
    const subagentMessages = compactSubagentStream.getProviderMessages();
    const userMsg = subagentMessages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const textContent = userMsg!.content
      .filter(
        (c): c is Extract<typeof c, { type: "text" }> => c.type === "text",
      )
      .map((c) => c.text)
      .join("");
    expect(textContent).toContain("2+2 equals 4");

    // Use real EDL tool to edit the temp file
    const tempFileMatch2 = textContent.match(/The file is at: ([^\n]+)/);
    expect(tempFileMatch2).toBeDefined();
    const tempFilePath2 = tempFileMatch2![1];

    const edlScript2 = `file \`${tempFilePath2}\`\nselect bof-eof\nreplace <<COMPACT_SUMMARY\n# Summary\nArithmetic conversation: 2+2=4, 3+3=6\nCOMPACT_SUMMARY`;

    compactSubagentStream.respond({
      stopReason: "tool_use",
      text: "I'll compact this conversation.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "edl_1" as ToolRequestId,
            toolName: "edl" as ToolName,
            input: { script: edlScript2 },
          },
        },
      ],
    });

    // EDL tool auto-executes, then compact subagent finishes
    const afterEdlStream2 = await driver.mockAnthropic.awaitPendingStream({
      message: "compact subagent after EDL in forked thread",
    });

    afterEdlStream2.respond({
      stopReason: "end_turn",
      text: "Compacted the arithmetic conversation.",
      toolRequests: [],
    });

    // After compact completes, the forked thread should continue with the next prompt
    const afterCompactStream = await driver.mockAnthropic.awaitPendingStream({
      message: "after compact in forked thread",
    });

    afterCompactStream.respond({
      stopReason: "end_turn",
      text: "Sure! What multiplication would you like help with?",
      toolRequests: [],
    });

    // Verify we're on the new forked thread (not the original)
    const newThread = driver.magenta.chat.getActiveThread();
    expect(newThread.id).not.toBe(originalThreadId);

    await driver.assertDisplayBufferContains(
      "What multiplication would you like help with?",
    );
  });
});

it("auto-compact triggers when inputTokenCount exceeds 80% of context window", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Build up some conversation history
    await driver.inputMagentaText("What is 2+2?");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream({
      message: "initial request",
    });
    request1.respond({
      stopReason: "end_turn",
      text: "2+2 equals 4.",
      toolRequests: [],
    });

    // Set the mock token count to exceed 80% of 200K context window (160K)
    driver.mockAnthropic.mockClient.mockInputTokenCount = 170_000;

    // Wait for countTokensPostFlight to run and update inputTokenCount
    await pollUntil(
      () => {
        const tokenCount = driver.magenta.chat
          .getActiveThread()
          .agent.getState().inputTokenCount;
        if (tokenCount === undefined || tokenCount < 160_000) {
          throw new Error(
            `expected inputTokenCount >= 160000 but got ${tokenCount}`,
          );
        }
      },
      { timeout: 2000, message: "inputTokenCount should be populated" },
    );

    const originalThread = driver.magenta.chat.getActiveThread();

    // Send another message - this should trigger auto-compact instead of normal send
    await driver.inputMagentaText("Now help me with multiplication");
    await driver.send();

    // The thread should enter compacting mode automatically
    await pollUntil(
      () => {
        if (originalThread.state.mode.type !== "compacting")
          throw new Error(
            `expected compacting mode but got ${originalThread.state.mode.type}`,
          );
      },
      { timeout: 2000, message: "thread should auto-compact" },
    );

    // Verify the nextPrompt was preserved
    if (originalThread.state.mode.type !== "compacting")
      throw new Error("expected compacting");
    expect(originalThread.state.mode.nextPrompt).toBe(
      "Now help me with multiplication",
    );

    // Complete the compact subagent flow
    const compactSubagentStream = await driver.mockAnthropic.awaitPendingStream(
      {
        message: "compact subagent stream",
      },
    );

    const subagentMessages = compactSubagentStream.getProviderMessages();
    const userMsg = subagentMessages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const textContent = userMsg!.content
      .filter(
        (c): c is Extract<typeof c, { type: "text" }> => c.type === "text",
      )
      .map((c) => c.text)
      .join("");
    expect(textContent).toContain("2+2 equals 4");

    const tempFileMatch = textContent.match(/The file is at: ([^\n]+)/);
    expect(tempFileMatch).toBeDefined();
    const tempFilePath = tempFileMatch![1];

    const edlScript = `file \`${tempFilePath}\`\nselect bof-eof\nreplace <<COMPACT_SUMMARY\n# Summary\nUser asked basic arithmetic: 2+2=4\nCOMPACT_SUMMARY`;

    compactSubagentStream.respond({
      stopReason: "tool_use",
      text: "I'll compact this conversation.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "edl_1" as ToolRequestId,
            toolName: "edl" as ToolName,
            input: { script: edlScript },
          },
        },
      ],
    });

    const afterEdlStream = await driver.mockAnthropic.awaitPendingStream({
      message: "compact subagent after EDL",
    });

    afterEdlStream.respond({
      stopReason: "end_turn",
      text: "I have compacted the conversation.",
      toolRequests: [],
    });

    // Reset mock token count so the post-compact conversation doesn't re-trigger
    driver.mockAnthropic.mockClient.mockInputTokenCount = 1000;

    // After compact, the parent thread should resume with the next prompt
    const afterCompactStream = await driver.mockAnthropic.awaitPendingStream({
      message: "after compact continuation",
    });

    const afterCompactMessages = afterCompactStream.getProviderMessages();
    const hasNextPrompt = afterCompactMessages.some(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (c) =>
            c.type === "text" &&
            c.text.includes("Now help me with multiplication"),
        ),
    );
    expect(hasNextPrompt).toBe(true);

    // The summary should be present
    const allText = afterCompactMessages
      .flatMap((m) =>
        m.content
          .filter(
            (c): c is Extract<typeof c, { type: "text" }> => c.type === "text",
          )
          .map((c) => c.text),
      )
      .join("");
    expect(allText).toContain("User asked basic arithmetic");

    afterCompactStream.respond({
      stopReason: "end_turn",
      text: "Sure! What multiplication would you like help with?",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains(
      "What multiplication would you like help with?",
    );
  });
});

it("auto-compact does not trigger on compact threads", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Build conversation and trigger manual @compact
    await driver.inputMagentaText("Hello");
    await driver.send();

    const stream1 = await driver.mockAnthropic.awaitPendingStream({
      message: "initial",
    });
    stream1.respond({
      stopReason: "end_turn",
      text: "Hi there!",
      toolRequests: [],
    });

    // Set extremely high token count to make sure it would trigger on a normal thread
    driver.mockAnthropic.mockClient.mockInputTokenCount = 190_000;

    // Wait for token count to propagate
    await pollUntil(
      () => {
        const tokenCount = driver.magenta.chat
          .getActiveThread()
          .agent.getState().inputTokenCount;
        if (tokenCount === undefined || tokenCount < 160_000) {
          throw new Error(`expected high token count but got ${tokenCount}`);
        }
      },
      { timeout: 2000, message: "inputTokenCount should be populated" },
    );

    // Trigger manual compact
    await driver.inputMagentaText("@compact Continue please");
    await driver.send();

    const originalThread = driver.magenta.chat.getActiveThread();

    await pollUntil(
      () => {
        if (originalThread.state.mode.type !== "compacting")
          throw new Error("expected compacting");
      },
      { timeout: 2000, message: "thread should enter compacting mode" },
    );

    // The compact subagent should proceed normally (not self-compact)
    const compactStream = await driver.mockAnthropic.awaitPendingStream({
      message: "compact subagent",
    });

    // The compact subagent should have received a stream (meaning it did NOT
    // auto-compact itself, which would have blocked it)
    expect(compactStream).toBeDefined();

    // Verify a compact thread was spawned
    const chat = driver.magenta.chat;
    const compactWrapper = Object.values(chat.threadWrappers).find(
      (w) =>
        w.state === "initialized" && w.thread.state.threadType === "compact",
    );
    expect(compactWrapper).toBeDefined();

    // Clean up: respond to the compact subagent
    const subagentMessages = compactStream.getProviderMessages();
    const userMsg = subagentMessages.find((m) => m.role === "user");
    const textContent = userMsg!.content
      .filter(
        (c): c is Extract<typeof c, { type: "text" }> => c.type === "text",
      )
      .map((c) => c.text)
      .join("");
    const tempFileMatch = textContent.match(/The file is at: ([^\n]+)/);
    const tempFilePath = tempFileMatch![1];
    const edlScript = `file \`${tempFilePath}\`\nselect bof-eof\nreplace <<COMPACT_SUMMARY\n# Summary\nHello conversation\nCOMPACT_SUMMARY`;

    compactStream.respond({
      stopReason: "tool_use",
      text: "Compacting.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "edl_1" as ToolRequestId,
            toolName: "edl" as ToolName,
            input: { script: edlScript },
          },
        },
      ],
    });

    const afterEdlStream = await driver.mockAnthropic.awaitPendingStream({
      message: "compact subagent after EDL",
    });
    afterEdlStream.respond({
      stopReason: "end_turn",
      text: "Done compacting.",
      toolRequests: [],
    });

    // Reset token count for the resumed conversation
    driver.mockAnthropic.mockClient.mockInputTokenCount = 1000;

    const afterCompactStream = await driver.mockAnthropic.awaitPendingStream({
      message: "after compact",
    });
    afterCompactStream.respond({
      stopReason: "end_turn",
      text: "Continuing!",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("Continuing!");
  });
});

it(
  "processes @diag keyword to include diagnostics in message",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // Create a file with syntax errors to generate diagnostics
      await driver.editFile("test.ts");
      await driver.showSidebar();

      // Wait for diagnostics to be available
      await pollUntil(
        async () => {
          const diagnostics = (await driver.nvim.call("nvim_exec_lua", [
            `return vim.diagnostic.get(nil)`,
            [],
          ])) as unknown[];

          if (diagnostics.length === 0) {
            throw new Error("No diagnostics available yet");
          }
        },
        { timeout: 5000 },
      );

      // Send a message with @diag keyword
      await driver.inputMagentaText("Help me fix this issue @diag");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I can see the diagnostics you've provided. Let me help you fix the issue.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains("Help me fix this issue @diag");

      // Verify the diagnostics are appended as a separate content block
      await driver.assertDisplayBufferContains("Current diagnostics:");
      await driver.assertDisplayBufferContains(
        "Property 'd' does not exist on type",
      );
      await driver.assertDisplayBufferContains("test.ts");

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have four content blocks: original text + diagnostics + system_reminder + checkpoint
      expect(messages[0].content.length).toBe(3);
      const content0 = messages[0].content[0];
      expect(content0.type).toBe("text");
      expect(
        (content0 as Extract<typeof content0, { type: "text" }>).text,
      ).toBe("Help me fix this issue @diag");
      const content1 = messages[0].content[1];
      expect(content1.type).toBe("text");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Current diagnostics:");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Property 'd' does not exist on type");
      expect(messages[0].content[2].type).toBe("system_reminder");
    });
  },
);

it(
  "processes @diagnostics keyword to include diagnostics in message",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // Create a file with syntax errors to generate diagnostics
      await driver.editFile("test.ts");
      await driver.showSidebar();

      // Wait for diagnostics to be available
      await pollUntil(
        async () => {
          const diagnostics = (await driver.nvim.call("nvim_exec_lua", [
            `return vim.diagnostic.get(nil)`,
            [],
          ])) as unknown[];

          if (diagnostics.length === 0) {
            throw new Error("No diagnostics available yet");
          }
        },
        { timeout: 5000 },
      );

      // Send a message with @diagnostics keyword
      await driver.inputMagentaText("Check these @diagnostics please");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I can see the diagnostics. Let me analyze them for you.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains(
        "Check these @diagnostics please",
      );

      // Verify the diagnostics are appended as a separate content block
      await driver.assertDisplayBufferContains("Current diagnostics:");
      await driver.assertDisplayBufferContains(
        "Property 'd' does not exist on type",
      );

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have three content blocks: original text + diagnostics + system_reminder
      expect(messages[0].content.length).toBe(3);
      const content0 = messages[0].content[0];
      expect(content0.type).toBe("text");
      expect(
        (content0 as Extract<typeof content0, { type: "text" }>).text,
      ).toBe("Check these @diagnostics please");
      const content1 = messages[0].content[1];
      expect(content1.type).toBe("text");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Current diagnostics:");
    });
  },
);
it(
  "processes @qf keyword to include quickfix list in message",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // Create some test quickfix entries
      await driver.nvim.call("nvim_command", [
        "call setqflist([" +
          "{'filename': 'test1.ts', 'lnum': 10, 'col': 5, 'text': 'Error: undefined variable'}," +
          "{'filename': 'test2.js', 'lnum': 25, 'col': 12, 'text': 'Warning: unused import'}" +
          "])",
      ]);

      await driver.showSidebar();

      // Send a message with @qf keyword
      await driver.inputMagentaText("Help me fix these issues @qf");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I can see the quickfix list you've provided. Let me help you fix these issues.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains("Help me fix these issues @qf");

      // Verify the quickfix list is appended as a separate content block
      await driver.assertDisplayBufferContains("Current quickfix list:");
      await driver.assertDisplayBufferContains("Error: undefined variable");
      await driver.assertDisplayBufferContains("Warning: unused import");
      await driver.assertDisplayBufferContains("test1.ts:10:5");
      await driver.assertDisplayBufferContains("test2.js:25:12");

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have three content blocks: original text + quickfix list + system_reminder
      expect(messages[0].content.length).toBe(3);
      const content0 = messages[0].content[0];
      expect(content0.type).toBe("text");
      expect(
        (content0 as Extract<typeof content0, { type: "text" }>).text,
      ).toBe("Help me fix these issues @qf");
      const content1 = messages[0].content[1];
      expect(content1.type).toBe("text");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Current quickfix list:");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Error: undefined variable");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Warning: unused import");
    });
  },
);

it(
  "processes @quickfix keyword to include quickfix list in message",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // Create some test quickfix entries
      await driver.nvim.call("nvim_command", [
        "call setqflist([" +
          "{'filename': 'error.py', 'lnum': 42, 'col': 1, 'text': 'SyntaxError: invalid syntax'}," +
          "{'filename': 'warning.js', 'lnum': 15, 'col': 8, 'text': 'Unused variable'}" +
          "])",
      ]);

      await driver.showSidebar();

      // Send a message with @quickfix keyword
      await driver.inputMagentaText("Check these @quickfix entries");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I can see the quickfix entries. Let me analyze them for you.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains("Check these @quickfix entries");

      // Verify the quickfix list is appended as a separate content block
      await driver.assertDisplayBufferContains("Current quickfix list:");
      await driver.assertDisplayBufferContains("SyntaxError: invalid syntax");
      await driver.assertDisplayBufferContains("Unused variable");
      await driver.assertDisplayBufferContains("error.py:42:1");
      await driver.assertDisplayBufferContains("warning.js:15:8");

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have three content blocks: original text + quickfix list + system_reminder
      expect(messages[0].content.length).toBe(3);
      const content0 = messages[0].content[0];
      expect(content0.type).toBe("text");
      expect(
        (content0 as Extract<typeof content0, { type: "text" }>).text,
      ).toBe("Check these @quickfix entries");
      const content1 = messages[0].content[1];
      expect(content1.type).toBe("text");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Current quickfix list:");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("SyntaxError: invalid syntax");
    });
  },
);

it(
  "handles empty quickfix list with @qf command",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // Clear quickfix list
      await driver.nvim.call("nvim_command", ["call setqflist([])"]);

      await driver.showSidebar();

      // Send a message with @qf keyword
      await driver.inputMagentaText("Any issues to fix? @qf");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I can see the quickfix list is empty. No issues to fix right now!",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains("Any issues to fix? @qf");

      // Verify the empty quickfix list is handled properly
      await driver.assertDisplayBufferContains("Current quickfix list:");

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have three content blocks: original text + empty quickfix list + system_reminder
      expect(messages[0].content.length).toBe(3);
      const content1 = messages[0].content[1];
      expect(content1.type).toBe("text");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toBe("Current quickfix list:\n");
    });
  },
);

it(
  "processes @buf keyword to include buffers list in message",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // Create some test buffers
      await driver.editFile("poem.txt");
      await driver.editFile("poem2.txt");
      await driver.showSidebar();

      // Send a message with @buf keyword
      await driver.inputMagentaText("Help me organize my files @buf");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I can see the buffers you have open. Let me help you organize them.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains(
        "Help me organize my files @buf",
      );

      // Verify the buffers list is appended as a separate content block
      await driver.assertDisplayBufferContains("Current buffers list:");
      await driver.assertDisplayBufferContains("poem.txt");
      await driver.assertDisplayBufferContains("active poem2.txt");

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have three content blocks: original text + buffers list + system_reminder
      expect(messages[0].content.length).toBe(3);
      const content0 = messages[0].content[0];
      expect(content0.type).toBe("text");
      expect(
        (content0 as Extract<typeof content0, { type: "text" }>).text,
      ).toBe("Help me organize my files @buf");
      const content1 = messages[0].content[1];
      expect(content1.type).toBe("text");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Current buffers list:");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("poem.txt");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("active poem2.txt");
    });
  },
);

it(
  "processes @buffers keyword to include buffers list in message",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // Create some test buffers
      await driver.editFile("poem.txt");
      await driver.editFile("poem2.txt");
      await driver.showSidebar();

      // Send a message with @buffers keyword
      await driver.inputMagentaText("Show me my current @buffers");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I can see your current buffers. Here's what you have open.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains("Show me my current @buffers");

      // Verify the buffers list is appended as a separate content block
      await driver.assertDisplayBufferContains("Current buffers list:");
      await driver.assertDisplayBufferContains("poem.txt");
      await driver.assertDisplayBufferContains("active poem2.txt");

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have three content blocks: original text + buffers list + system_reminder
      expect(messages[0].content.length).toBe(3);
      const content0 = messages[0].content[0];
      expect(content0.type).toBe("text");
      expect(
        (content0 as Extract<typeof content0, { type: "text" }>).text,
      ).toBe("Show me my current @buffers");
      const content1 = messages[0].content[1];
      expect(content1.type).toBe("text");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Current buffers list:");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("poem.txt");
    });
  },
);

it(
  "handles empty buffers list with @buf command",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Send a message with @buf keyword
      await driver.inputMagentaText("What files do I have open? @buf");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I can see your current buffers. It looks like you have minimal files open.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains(
        "What files do I have open? @buf",
      );

      // Verify the buffers list is handled properly
      await driver.assertDisplayBufferContains("Current buffers list:");

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have three content blocks: original text + buffers list + system_reminder
      expect(messages[0].content.length).toBe(3);
      const content1 = messages[0].content[1];
      expect(content1.type).toBe("text");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Current buffers list:");
    });
  },
);

it(
  "processes @diff command to include git diff in message",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // First, initialize git and commit the file so we can create a diff
      const cwd = await getcwd(driver.nvim);
      await within(async () => {
        $.cwd = cwd;
        // stage the file
        await $`git add poem.txt`;
        // add an unstaged change
        await $`echo 'modified content' >> poem.txt`;
      });

      await driver.showSidebar();

      // Send a message with @diff command
      await driver.inputMagentaText("Show me changes in @diff:poem.txt");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();

      // Check that the request messages contain the git diff
      const userMessage = stream.messages.find((msg) => msg.role === "user");
      expect(userMessage).toBeDefined();
      const userContent = userMessage!.content;
      expect(Array.isArray(userContent)).toBe(true);
      if (!Array.isArray(userContent)) throw new Error("Expected array");
      expect(userContent.length).toBeGreaterThan(1);

      // Find the diff content block in the request
      const diffContent = userContent.find(
        (content) =>
          content.type === "text" &&
          content.text.includes("Git diff for `poem.txt`:") &&
          content.text.includes("modified content"),
      );
      expect(diffContent).toBeDefined();

      stream.respond({
        stopReason: "end_turn",
        text: "I can see the git diff you've provided. Let me analyze the changes.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains(
        "Show me changes in @diff:poem.txt",
      );

      // Verify git diff content is included
      await driver.assertDisplayBufferContains("Git diff for `poem.txt`:");
      await driver.assertDisplayBufferContains("modified content");
    });
  },
);

it(
  "processes @staged command to include staged diff in message",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // First, initialize git and commit the file so we can create a staged diff
      const cwd = await getcwd(driver.nvim);
      await within(async () => {
        $.cwd = cwd;
        await $`echo 'staged content' >> poem2.txt`;
        await $`git add poem2.txt`;
      });

      await driver.showSidebar();

      // Send a message with @staged command
      await driver.inputMagentaText("Review staged changes @staged:poem2.txt");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();

      // Check that the request messages contain the staged diff
      const userMessage = stream.messages.find((msg) => msg.role === "user");
      expect(userMessage).toBeDefined();
      const userContent = userMessage!.content;
      expect(Array.isArray(userContent)).toBe(true);
      if (!Array.isArray(userContent)) throw new Error("Expected array");
      expect(userContent.length).toBeGreaterThan(1);

      // Find the staged diff content block in the request
      const stagedContent = userContent.find(
        (content) =>
          content.type === "text" &&
          content.text.includes("Staged diff for `poem2.txt`:") &&
          content.text.includes("staged content"),
      );
      expect(stagedContent).toBeDefined();

      stream.respond({
        stopReason: "end_turn",
        text: "I can see the staged changes you've provided. Let me review them.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains(
        "Review staged changes @staged:poem2.txt",
      );

      // Verify staged diff content is included
      await driver.assertDisplayBufferContains("Staged diff for `poem2.txt`:");
      await driver.assertDisplayBufferContains("staged content");
    });
  },
);

it("handles @file commands", { timeout: 10000 }, async () => {
  await withDriver({}, async (driver) => {
    // Create test files
    await driver.editFile("poem.txt");
    await driver.editFile("poem2.txt");
    await driver.showSidebar();

    // Send a message with multiple @file commands
    await driver.inputMagentaText(
      "Compare these files @file:poem.txt and @file:poem2.txt",
    );
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();

    // Check that the request messages contain context updates for the added files
    const userMessage = stream.messages.find((msg) => msg.role === "user");
    expect(userMessage).toBeDefined();
    const userContent = userMessage!.content;
    expect(Array.isArray(userContent)).toBe(true);
    if (!Array.isArray(userContent)) throw new Error("Expected array");

    // Look for context updates in the request messages - they should appear as text content
    // containing the file contents
    const contextContent = userContent.find(
      (content) =>
        content.type === "text" &&
        (content.text.includes("poem.txt") ||
          content.text.includes("poem2.txt")),
    );
    expect(contextContent).toBeDefined();

    stream.respond({
      stopReason: "end_turn",
      text: "I can see both files you've added to context. Let me compare them.",
      toolRequests: [],
    });

    // Verify the original message is displayed
    await driver.assertDisplayBufferContains(
      "Compare these files @file:poem.txt and @file:poem2.txt",
    );

    // Verify both files were added to context manager
    const thread = driver.magenta.chat.getActiveThread();
    const contextManager = thread.contextManager;
    const files = contextManager.files;

    // Check that both files are in the context
    const hasPoem1 = Object.keys(files).some((path) =>
      path.includes("poem.txt"),
    );
    const hasPoem2 = Object.keys(files).some((path) =>
      path.includes("poem2.txt"),
    );
    expect(hasPoem1).toBe(true);
    expect(hasPoem2).toBe(true);
  });
});

it(
  "handles @file command with non-existent file",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Send a message with @file command for non-existent file
      await driver.inputMagentaText("Help with @file:nonexistent.txt");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I see there was an error adding that file to context.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains(
        "Help with @file:nonexistent.txt",
      );

      // Verify error message is included
      await driver.assertDisplayBufferContains("Error adding file to context");
      await driver.assertDisplayBufferContains("nonexistent.txt");

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have multiple content blocks including error
      expect(messages[0].content.length).toBeGreaterThan(1);

      // The user message should have multiple content blocks including error
      expect(messages[0].content.length).toBeGreaterThan(1);

      // Find the error content block
      const errorContent = messages[0].content.find(
        (content) =>
          content.type === "text" &&
          content.text.includes("Error adding file to context"),
      );
      expect(errorContent).toBeDefined();
    });
  },
);

it.skip("display multiple edits to the same file, and edit details", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`Update the poem in the file poem.txt`);
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();
    stream.respond({
      stopReason: "tool_use",
      text: "ok, I will try to rewrite the poem in that file",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "id1" as ToolRequestId,
            toolName: "replace" as ToolName,
            input: {
              filePath: "poem.txt" as UnresolvedFilePath,
              find: `Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.`,
              replace: `Replace 1
Replace 2`,
            },
          },
        },
      ],
    });
    await driver.assertDisplayBufferContains(`\
# user:
Update the poem in the file poem.txt`);

    await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file
✏️✅ Replace [[ -4 / +2 ]] in \`poem.txt\`
\`\`\`diff
-Moonlight whispers through the trees,
-Silver shadows dance with ease.
-Stars above like diamonds bright,
-Paint their stories in the night.
\\ No newline at end of file
+Replace 1
+Replace 2
\\ No newline at end of file

\`\`\``);

    await driver.assertDisplayBufferContains(`\
Edits:
- \`poem.txt\` (1 edits). [± diff snapshot]`);

    const reviewPos = await driver.assertDisplayBufferContains("diff snapshot");
    await driver.triggerDisplayBufferKey(reviewPos, "<CR>");

    await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file
✏️✅ Replace [[ -4 / +2 ]] in \`poem.txt\``);

    // Go back to main view
    await driver.triggerDisplayBufferKey(reviewPos, "<CR>");

    await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file
✏️✅ Replace [[ -4 / +2 ]] in \`poem.txt\``);
  });
});

it("displays deleted context updates correctly", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Create a temporary file for testing
    const cwd = await getcwd(driver.nvim);
    const tempFilePath = resolveFilePath(
      cwd,
      "temp-delete-test.txt" as UnresolvedFilePath,
      os.homedir() as HomeDir,
    );
    const tempContent = "temporary file content\nfor testing deletion";
    await fs.promises.writeFile(tempFilePath, tempContent);

    // Add file to context
    await driver.addContextFiles("temp-delete-test.txt");

    // Verify file is in context
    await driver.assertDisplayBufferContains(`\
# context:
- \`temp-delete-test.txt\``);

    // Delete the file from disk
    await fs.promises.unlink(tempFilePath);

    // Send a message to trigger context update
    await driver.inputMagentaText("What happened to the file?");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();

    // Check that the request contains the file deletion update
    stream.messages.find(
      (msg) =>
        msg.role === "user" &&
        typeof msg.content === "object" &&
        lodash.some(
          msg.content,
          (b) =>
            b.type === "text" &&
            b.text.includes("temp-delete-test.txt") &&
            b.text.includes("This file has been deleted"),
        ),
    );

    stream.respond({
      stopReason: "end_turn",
      text: "I can see the file has been deleted from context.",
      toolRequests: [],
    });

    // Verify the display shows the deletion indicator - check pieces separately
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains("Context Updates:");
    await driver.assertDisplayBufferContains(
      "`temp-delete-test.txt` [ deleted ]",
    );
    await driver.assertDisplayBufferContains("What happened to the file?");
    await driver.assertDisplayBufferContains("# assistant:");
    await driver.assertDisplayBufferContains(
      "I can see the file has been deleted from context.",
    );
  });
});

it("handles web search results and citations together", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(
      `Compare TypeScript and JavaScript for large projects`,
    );
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();

    // Stream server tool use (web search)
    stream.streamServerToolUse("search_1", "web_search", {
      query: "TypeScript vs JavaScript large projects",
    });

    // Stream web search result
    stream.streamWebSearchToolResult("search_1", [
      {
        type: "web_search_result",
        title: "TypeScript vs JavaScript: Which Is Better for Your Project?",
        url: "https://example.com/typescript-vs-javascript",
        encrypted_content: "",
        page_age: "3 months ago",
      },
    ] as WebSearchResultBlock[]);

    // Stream text content
    stream.streamText(
      "TypeScript offers significant advantages for large projects compared to JavaScript.",
    );

    // Finish the response
    stream.finishResponse("end_turn");

    // Verify content pieces separately to allow for system reminder
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains(
      "Compare TypeScript and JavaScript for large projects",
    );
    await driver.assertDisplayBufferContains("# assistant:");
    await driver.assertDisplayBufferContains(
      "🔍 Searching TypeScript vs JavaScript large projects...",
    );
    await driver.assertDisplayBufferContains("🌐 1 search result");

    await driver.assertDisplayBufferContains(
      "TypeScript offers significant advantages for large projects compared to JavaScript.",
    );
    await driver.assertDisplayBufferContains("Stopped (end_turn)");
  });
});

it("handles thinking and redacted thinking blocks", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(
      "What should I consider when designing a database schema?",
    );
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();

    // Stream thinking block
    stream.streamThinking("abc\ndef\nghi");

    // Stream redacted thinking block
    stream.streamRedactedThinking(
      "This thinking contains sensitive information that has been redacted.",
    );

    stream.finishResponse("end_turn");

    // Assert initial collapsed state of thinking block - check pieces separately
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains(
      "What should I consider when designing a database schema?",
    );
    await driver.assertDisplayBufferContains("# assistant:");
    await driver.assertDisplayBufferContains("💭 [Thinking]");
    await driver.assertDisplayBufferContains("💭 [Redacted Thinking]");

    // Test expanding the thinking block
    const thinkingPos =
      await driver.assertDisplayBufferContains("💭 [Thinking]");
    await driver.triggerDisplayBufferKey(thinkingPos, "<CR>");

    // Verify expanded thinking block - check pieces separately
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains(
      "What should I consider when designing a database schema?",
    );
    await driver.assertDisplayBufferContains("# assistant:");
    await driver.assertDisplayBufferContains("💭 [Thinking]");
    await driver.assertDisplayBufferContains("abc");
    await driver.assertDisplayBufferContains("def");
    await driver.assertDisplayBufferContains("ghi");
    await driver.assertDisplayBufferContains("💭 [Redacted Thinking]");

    // Test collapsing the thinking block
    const expandedThinkingPos =
      await driver.assertDisplayBufferContains("💭 [Thinking]");
    await driver.triggerDisplayBufferKey(expandedThinkingPos, "<CR>");

    // Verify collapsed thinking block again - check pieces separately
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains(
      "What should I consider when designing a database schema?",
    );
    await driver.assertDisplayBufferContains("# assistant:");
    await driver.assertDisplayBufferContains("💭 [Thinking]");
    await driver.assertDisplayBufferContains("💭 [Redacted Thinking]");

    // Send a followup message to test that thinking blocks are included in context
    await driver.inputMagentaText("Can you elaborate on normalization?");
    await driver.send();

    const followupStream = await driver.mockAnthropic.awaitPendingStream();

    // Verify that the followup request includes both thinking blocks in messages
    const assistantMessage = followupStream.messages.find(
      (msg) => msg.role === "assistant",
    );
    expect(assistantMessage).toBeTruthy();
    const assistantContent = assistantMessage!.content;
    expect(Array.isArray(assistantContent)).toBe(true);
    if (!Array.isArray(assistantContent)) throw new Error("Expected array");
    expect(assistantContent).toHaveLength(2);

    // Check thinking block is included with full content
    const thinkingContent = assistantContent[0];
    expect(thinkingContent.type).toBe("thinking");
    expect(
      (thinkingContent as Extract<typeof thinkingContent, { type: "thinking" }>)
        .thinking,
    ).toEqual("abc\ndef\nghi");

    const redactedThinkingContent = assistantContent[1];
    expect(redactedThinkingContent.type).toBe("redacted_thinking");
    expect(
      (
        redactedThinkingContent as Extract<
          typeof redactedThinkingContent,
          { type: "redacted_thinking" }
        >
      ).data,
    ).toBe(
      "This thinking contains sensitive information that has been redacted.",
    );
  });
});

it("handles streaming thinking blocks correctly", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Explain how async/await works");
    await driver.send();

    const stream = await driver.mockAnthropic.mockClient.awaitStream();
    const thinkingIndex = stream.nextBlockIndex();

    // Start streaming thinking block
    stream.emitEvent({
      type: "content_block_start",
      index: thinkingIndex,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });

    // Add thinking content in multiple chunks to test streaming
    stream.emitEvent({
      type: "content_block_delta",
      index: thinkingIndex,
      delta: {
        type: "thinking_delta",
        thinking:
          "I need to explain async/await.\n\nThis is a JavaScript feature that makes asynchronous code look synchronous.",
      },
    });

    // Assert that during streaming, we see the preview with last line
    await driver.assertDisplayBufferContains(
      "💭 [Thinking] This is a JavaScript feature that makes asynchronous code look synchronous.",
    );

    // Add more content to the thinking block
    stream.emitEvent({
      type: "content_block_delta",
      index: thinkingIndex,
      delta: {
        type: "thinking_delta",
        thinking: "\n\nIt's built on top of Promises.",
      },
    });

    // Assert that the preview now shows the new last line
    await driver.assertDisplayBufferContains(
      "💭 [Thinking] It's built on top of Promises.",
    );
  });
});

it("shows EDL script preview while streaming", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Edit a file for me");
    await driver.send();

    const stream = await driver.mockAnthropic.mockClient.awaitStream();
    const toolIndex = stream.nextBlockIndex();

    // Start streaming an edl tool_use block
    stream.emitEvent({
      type: "content_block_start",
      index: toolIndex,
      content_block: {
        type: "tool_use",
        id: "edl-preview-test",
        name: "edl",
        input: {},
      },
    });

    // Stream partial input JSON with escaped newlines
    stream.emitEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: '{"script": "file `src/utils.ts`\\nselect',
      },
    });

    // Assert the display shows the unescaped script with newlines separating commands
    await driver.assertDisplayBufferContains(
      "📝 edl:\nfile `src/utils.ts`\nselect",
    );

    // Stream more of the script
    stream.emitEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: " /oldFunc/\\nextend_forward",
      },
    });

    await driver.assertDisplayBufferContains("extend_forward");
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

it("handles @async messages by queueing them and sending on next tool response", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // First, send a regular message that will use a secret file read
    await driver.inputMagentaText("Can you read my secret file?");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();
    const toolRequestId = "secret-file-tool" as ToolRequestId;

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

    // Now send an @async message while the tool is waiting for approval
    await driver.inputMagentaText("@async This should be queued");
    await driver.send();

    // Verify the @async message is queued, not immediately sent
    const thread = driver.magenta.chat.getActiveThread();
    expect(thread.state.pendingMessages).toHaveLength(1);
    expect(thread.state.pendingMessages[0].text).toBe("This should be queued");

    // Approve the file read to complete the tool execution
    const yesPos = await driver.assertDisplayBufferContains("> YES");
    await driver.triggerDisplayBufferKey(yesPos, "<CR>");

    // Wait for file read to complete
    await driver.assertDisplayBufferContains("👀✅ `.secret`");

    // Handle the auto-response after tool completion
    const stream2 = await driver.mockAnthropic.awaitPendingStream();

    // Verify the message structure follows the expected pattern
    const messagePattern = stream2.messages.flatMap((m) =>
      typeof m.content == "string"
        ? "stringmessage"
        : m.content.map((c) => `${m.role}:${c.type}`),
    );

    expect(
      messagePattern,
      "tool_use immediately followed by tool_result",
    ).toEqual([
      "user:text",
      "user:text", // system_reminder converted to text
      "assistant:text",
      "assistant:tool_use",
      "user:tool_result",
      "user:text",
      "user:text", // system_reminder converted to text
    ]);
    expect(stream2.messages).toMatchSnapshot();
  });
});

it("handles @async messages and sends them on end turn", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Send a regular message
    await driver.inputMagentaText("Tell me about TypeScript");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();

    // Send @async message while first request is in flight
    await driver.inputMagentaText("@async Also tell me about JavaScript");
    await driver.send();

    // Verify message is queued
    const thread = driver.magenta.chat.getActiveThread();
    expect(thread.state.pendingMessages).toHaveLength(1);
    expect(thread.state.pendingMessages[0].text).toBe(
      "Also tell me about JavaScript",
    );

    // Respond to first request with end_turn - this should trigger sending queued messages
    request1.respond({
      stopReason: "end_turn",
      text: "TypeScript is a typed superset of JavaScript.",
      toolRequests: [],
    });

    // Now the queued message should be sent automatically
    const request2 = await driver.mockAnthropic.awaitPendingStream();
    expect(request2.messages).toMatchSnapshot();
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

it("should process custom commands in messages", async () => {
  await withDriver(
    {
      options: {
        customCommands: [
          {
            name: "@nedit",
            text: "DO NOT MAKE ANY EDITS TO CODE",
            description: "Disable all code editing functionality",
          },
        ],
      },
    },
    async (driver) => {
      await driver.showSidebar();
      await driver.waitForChatReady();

      await driver.inputMagentaText("@nedit Please help with this task");
      await driver.send();

      // Wait for the message to be processed and displayed
      await driver.assertDisplayBufferContains("DO NOT MAKE ANY EDITS TO CODE");
    },
  );
});

it("renders successive tool uses with single assistant header and inline metadata", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Read two files for me");
    await driver.send();

    const stream1 = await driver.mockAnthropic.awaitPendingStream();

    // First tool use
    stream1.respond({
      stopReason: "tool_use",
      text: "I'll read the first file.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool-1" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: { filePath: "poem.txt" as UnresolvedFilePath },
          },
        },
      ],
    });

    // Wait for first tool to complete (auto-approved for poem.txt)
    await driver.assertDisplayBufferContains("👀✅ `poem.txt`");

    // Second request - thinking then another tool use
    const stream2 = await driver.mockAnthropic.awaitPendingStream();
    stream2.streamThinking("Let me read the second file now.");
    stream2.respond({
      stopReason: "tool_use",
      text: "",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool-2" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: { filePath: "poem2.txt" as UnresolvedFilePath },
          },
        },
      ],
    });

    // Wait for second tool to complete
    await driver.assertDisplayBufferContains("👀✅ `poem2.txt`");

    // Third request - final response
    const stream3 = await driver.mockAnthropic.awaitPendingStream();
    stream3.respond({
      stopReason: "end_turn",
      text: "I've read both files for you.",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("I've read both files for you.");

    // Get the display buffer and verify the format via snapshot
    const displayText = sanitizeDisplayForSnapshot(
      await driver.getDisplayBufferText(),
    );

    // Snapshot the full display to verify:
    // 1. Only ONE "# assistant:" header for the entire turn
    // 2. System reminders and checkpoints are inline (📋 [System Reminder]🏁 [Checkpoint])
    // 3. No blank lines between tool results and metadata
    expect(displayText).toMatchSnapshot("successive-tool-uses-display");
  });
});

it("followup user message text is visible after tool-use cycle", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Send initial message
    await driver.inputMagentaText("Read a file for me");
    await driver.send();

    const stream1 = await driver.mockAnthropic.awaitPendingStream();
    const toolRequestId = "read-file-1" as ToolRequestId;

    // Respond with a tool use
    stream1.respond({
      stopReason: "tool_use",
      text: "I'll read the file for you.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "get_file" as ToolName,
            input: { filePath: "./poem.txt" as UnresolvedFilePath },
          },
        },
      ],
    });

    // Wait for tool to auto-execute and complete
    await driver.assertDisplayBufferContains("poem.txt");

    // Auto-respond after tool completion
    const stream2 = await driver.mockAnthropic.awaitPendingStream();
    stream2.respond({
      stopReason: "end_turn",
      text: "I've read the file. It contains a poem about moonlight.",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("poem about moonlight");

    // Now send a followup message
    await driver.inputMagentaText("Now edit the poem to be about sunshine");
    await driver.send();

    const stream3 = await driver.mockAnthropic.awaitPendingStream();
    stream3.respond({
      stopReason: "end_turn",
      text: "I'll edit the poem for you.",
      toolRequests: [],
    });

    // Verify the followup user message text is visible in the display
    await driver.assertDisplayBufferContains(
      "Now edit the poem to be about sunshine",
    );

    // Verify the assistant response to the followup is also visible
    await driver.assertDisplayBufferContains("I'll edit the poem for you.");

    // Snapshot the full display for verification
    const displayText = sanitizeDisplayForSnapshot(
      await driver.getDisplayBufferText(),
    );
    expect(displayText).toMatchSnapshot("followup-message-after-tool-use");
  });
});

it("followup user message text is visible with context updates", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Add a file to context and send initial message
    await driver.addContextFiles("poem.txt");
    await driver.inputMagentaText("Help me with this poem");
    await driver.send();

    const stream1 = await driver.mockAnthropic.awaitPendingStream();
    stream1.respond({
      stopReason: "end_turn",
      text: "I can see the poem. What would you like me to do?",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("What would you like me to do?");

    // Modify the file externally to trigger a context update on next message
    const cwd = await getcwd(driver.nvim);
    await fs.promises.writeFile(
      `${cwd}/poem.txt`,
      "sunshine poem\nwith extra lines",
    );

    // Send a followup message - this should include context updates
    await driver.inputMagentaText("Now make the poem longer please");
    await driver.send();

    const stream2 = await driver.mockAnthropic.awaitPendingStream();
    stream2.respond({
      stopReason: "end_turn",
      text: "I'll make the poem longer.",
      toolRequests: [],
    });

    // Verify the followup user message text is visible in the display
    await driver.assertDisplayBufferContains("Now make the poem longer please");

    // Verify the assistant response to the followup is also visible
    await driver.assertDisplayBufferContains("I'll make the poem longer.");

    // Snapshot the full display for verification
    const displayText = sanitizeDisplayForSnapshot(
      await driver.getDisplayBufferText(),
    );
    expect(displayText).toMatchSnapshot("followup-with-context-updates");
  });
});
