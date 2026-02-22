import { withDriver } from "../test/preamble.ts";
import { type ToolRequestId } from "../tools/toolManager.ts";
import { expect, it } from "vitest";
import type { ToolName } from "../tools/types.ts";
import { pollUntil } from "../utils/async.ts";

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

    // Have the compact subagent use the EDL tool to edit /summary.md in memory
    const edlScript = `file \`/summary.md\`\nselect bof-eof\nreplace <<COMPACT_SUMMARY\n# Summary\nUser asked basic arithmetic: 2+2=4, 3+3=6\nCOMPACT_SUMMARY`;

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

    // The compact subagent must write to /summary.md via EDL
    const edlScript = `file \`/summary.md\`\nselect bof-eof\nreplace <<COMPACT_SUMMARY\n# Summary\nGreeting conversation: user said hello, assistant responded.\nCOMPACT_SUMMARY`;

    compactStream.respond({
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
      text: "Done compacting.",
      toolRequests: [],
    });

    // Without a next prompt, the thread sends "Please continue from where you left off."
    const afterCompactStream = await driver.mockAnthropic.awaitPendingStream({
      message: "after compact continuation",
    });
    afterCompactStream.respond({
      stopReason: "end_turn",
      text: "Ready to continue!",
      toolRequests: [],
    });

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

    // Verify messages have been compacted - fresh agent with summary + continuation
    const messages = thread.getMessages();
    expect(messages.length).toBeLessThanOrEqual(4);
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

    // Have the compact subagent edit /summary.md with a summary that also contains @file
    const edlScript = `file \`/summary.md\`\nselect bof-eof\nreplace <<COMPACT_SUMMARY\n# Summary\nUser discussed @file:poem.txt usage. Assistant explained the command.\nCOMPACT_SUMMARY`;

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

    // Use real EDL tool to edit /summary.md in memory
    const edlScript2 = `file \`/summary.md\`\nselect bof-eof\nreplace <<COMPACT_SUMMARY\n# Summary\nArithmetic conversation: 2+2=4, 3+3=6\nCOMPACT_SUMMARY`;

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

    const edlScript = `file \`/summary.md\`\nselect bof-eof\nreplace <<COMPACT_SUMMARY\n# Summary\nUser asked basic arithmetic: 2+2=4\nCOMPACT_SUMMARY`;

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
    // Verify the thread is in compacting mode with an internal compact agent
    expect(originalThread.state.mode.type).toBe("compacting");

    // Clean up: respond to the compact subagent

    const edlScript = `file \`/summary.md\`\nselect bof-eof\nreplace <<COMPACT_SUMMARY\n# Summary\nHello conversation\nCOMPACT_SUMMARY`;

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
