import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/core";
import {
  AutoCompactSupervisor,
  compactionRunThreadIds,
  type ThreadCompactor,
} from "@magenta/core";
import { expect, it } from "vitest";
import type { MockStream } from "../providers/mock-anthropic-client.ts";
import type { ScriptInvocationId } from "../scripts/script-manager.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";
import type { NvimThread } from "./thread.ts";

function compactorOf(thread: NvimThread): ThreadCompactor {
  if (!thread.compactor) throw new Error("thread has no compactor");
  return thread.compactor;
}
function isCompacting(thread: NvimThread): boolean {
  return compactorOf(thread).current !== undefined;
}
/** The runs that have settled, in order. */
function finishedRuns(thread: NvimThread) {
  return compactorOf(thread).runs.filter((run) => run.type !== "running");
}
let yieldSeq = 0;
/** A compact chunk thread hands its summary back the way every child thread
 * does: by calling yield_to_parent. */
function yieldChunk(stream: MockStream): void {
  yieldSeq += 1;
  stream.respond({
    stopReason: "tool_use",
    text: "Summary written.",
    toolRequests: [
      {
        status: "ok",
        value: {
          id: `yield_${yieldSeq}` as ToolRequestId,
          toolName: "yield_to_parent" as ToolName,
          input: { result: "wrote /summary.md" },
        },
      },
    ],
  });
}

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

    // Wait for second response to be fully processed
    await pollUntil(() => {
      if (originalThread.getMessages().length >= 4) return true;
      throw new Error("waiting for messages");
    });

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
        if (!isCompacting(originalThread))
          throw new Error("expected the thread to be compacting");
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
        (c): c is Extract<typeof c, { type: "text" | "context_update" }> =>
          c.type === "text" || c.type === "context_update",
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

    yieldChunk(afterEdlStream);

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
        if (!isCompacting(thread))
          throw new Error("expected the thread to be compacting");
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
    yieldChunk(afterEdlStream);

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
        const agentPhase = thread.agent.phase;
        if (agentPhase.type !== "idle")
          throw new Error(`expected idle but got ${agentPhase.type}`);
        const turnResult = thread.core.state.lastTurnResult;
        if (turnResult?.type !== "stopped")
          throw new Error(`expected stopped but got ${turnResult?.type}`);
        if (turnResult.stopReason !== "end_turn")
          throw new Error(`expected end_turn but got ${turnResult.stopReason}`);
      },
      { timeout: 2000, message: "thread should stop after compaction" },
    );

    // Verify messages have been compacted - fresh agent with summary + continuation
    const messages = thread.getMessages();
    expect(messages.length).toBeLessThanOrEqual(4);
  });
});

it("lets the user rescue a chunk thread whose turn failed", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

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
    await driver.inputMagentaText("@compact");
    await driver.send();

    await pollUntil(
      () => {
        if (!isCompacting(thread))
          throw new Error("expected the thread to be compacting");
      },
      { timeout: 2000, message: "thread should enter compacting mode" },
    );

    const compactStream = await driver.mockAnthropic.awaitPendingStream({
      message: "compact subagent stream",
    });
    compactStream.respondWithError(
      new Error("compaction request blew up (non-retryable)"),
    );
    // A chunk thread that fails is just a stuck thread: the run stays in
    // flight and the parked submission waits for the user to drive it home.
    const chunkThreadId = compactorOf(thread).current!.activeThreadId;
    await pollUntil(
      () => {
        const wrapper = driver.magenta.chat.threadWrappers[chunkThreadId];
        if (wrapper?.state !== "initialized") throw new Error("waiting");
        if (wrapper.thread.agent.phase.type !== "idle")
          throw new Error("waiting for the failed chunk thread to settle");
      },
      { timeout: 5000, message: "chunk thread should settle after the error" },
    );
    expect(isCompacting(thread)).toBe(true);
    expect(finishedRuns(thread)).toHaveLength(0);
    // The user opens the chunk thread and nudges it; when it yields, the
    // compaction picks up where it left off with no extra plumbing.
    driver.magenta.dispatch({
      type: "thread-msg",
      id: chunkThreadId,
      msg: {
        type: "send-message",
        messages: [{ type: "user", text: "try again" }],
      },
    });
    const retryStream = await driver.mockAnthropic.awaitPendingStream({
      message: "chunk thread retry",
    });
    retryStream.respond({
      stopReason: "tool_use",
      text: "Retrying.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "edl_retry" as ToolRequestId,
            toolName: "edl" as ToolName,
            input: {
              script:
                "file `/summary.md`\nselect bof-eof\nreplace <<S\n# Summary\nrecovered\nS",
            },
          },
        },
      ],
    });
    const afterRetry = await driver.mockAnthropic.awaitPendingStream({
      message: "chunk thread after retry edl",
    });
    yieldChunk(afterRetry);
    const continuation = await driver.mockAnthropic.awaitPendingStream({
      message: "parent continuation",
    });
    continuation.respond({
      stopReason: "end_turn",
      text: "Back on track.",
      toolRequests: [],
    });
    await driver.assertDisplayBufferContains("Back on track.");
    const runs = finishedRuns(thread);
    expect(runs).toHaveLength(1);
    expect(runs[0].type).toBe("done");
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
        if (!isCompacting(thread))
          throw new Error("expected the thread to be compacting");
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
    yieldChunk(afterEdlStream);

    // 2. Verify that after compaction:
    //    - The summary is sent as a raw user message (no command processing)
    //    - The nextPrompt goes through sendMessage, so @file:poem.txt IS expanded
    const afterCompactStream = await driver.mockAnthropic.awaitPendingStream({
      message: "after compact continuation",
    });

    const afterCompactMessages = afterCompactStream.getProviderMessages();

    // The summary and the nextPrompt now ride in a single opening turn, so
    // they land in one user message: the raw summary block first (no command
    // processing), then the nextPrompt's blocks (@file expanded).
    const userMessages = afterCompactMessages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    const blocks = userMessages[0].content;
    expect(blocks[0].type).toBe("text");
    const summaryText = (
      blocks[0] as Extract<(typeof blocks)[0], { type: "text" }>
    ).text;
    expect(summaryText).toContain("<conversation-summary>");
    expect(summaryText).toContain("@file:poem.txt");
    const promptText = blocks
      .slice(1)
      .filter(
        (c): c is Extract<(typeof blocks)[0], { type: "text" }> =>
          c.type === "text",
      )
      .map((c) => c.text)
      .join("\n");
    expect(promptText).toContain("Now read @file:poem.txt and summarize");

    // The context manager belongs to the thread, not to the agent compaction
    // replaces, so files the user put in context stay in context.
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

    // Fork by pressing F on the most recent assistant message, then send
    // @compact + new prompt on the forked thread.
    await driver.pressOnDisplayMessage("3+3 equals 6.", "F");

    await pollUntil(() => {
      if (driver.magenta.chat.state.activeThreadId === originalThreadId) {
        throw new Error("Still on original thread");
      }
    });

    await driver.inputMagentaText("@compact Now help me with multiplication");
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
        (c): c is Extract<typeof c, { type: "text" | "context_update" }> =>
          c.type === "text" || c.type === "context_update",
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

    yieldChunk(afterEdlStream2);

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

it("auto-compact threshold from options wires into the thread's supervisor", async () => {
  await withDriver(
    { options: { autoCompactThreshold: 160_000 } },
    async (driver) => {
      await driver.showSidebar();

      // inputTokenCount lags one turn (populated post-flight), so set it high
      // before the first turn. The first turn's handoff sees an undefined count
      // and never compacts.
      driver.mockAnthropic.mockClient.mockInputTokenCount = 170_000;

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

      const originalThread = driver.magenta.chat.getActiveThread();

      // The supervisor built from options should carry the configured threshold.
      const autoCompact = originalThread.supervisors.find(
        (s): s is AutoCompactSupervisor => s instanceof AutoCompactSupervisor,
      );
      expect(autoCompact).toBeDefined();

      await pollUntil(
        () => {
          const state = originalThread.agent.log;
          if (originalThread.agent.phase.type !== "idle")
            throw new Error("waiting for stop");
          if (
            state.inputTokenCount === undefined ||
            state.inputTokenCount < 160_000
          ) {
            throw new Error(
              `expected inputTokenCount >= 160000 but got ${state.inputTokenCount}`,
            );
          }
        },
        { timeout: 2000, message: "inputTokenCount should be populated" },
      );

      // Drive a second turn. At its handoff the over-threshold count triggers
      // the options-configured supervisor without any manual override.
      await driver.inputMagentaText("Another question");
      await driver.send();

      const request2 = await driver.mockAnthropic.awaitPendingStream({
        message: "second request",
      });
      request2.respond({
        stopReason: "end_turn",
        text: "Sure, happy to help.",
        toolRequests: [],
      });

      await pollUntil(
        () => {
          if (!isCompacting(originalThread))
            throw new Error("expected the thread to be compacting");
        },
        { timeout: 2000, message: "thread should auto-compact" },
      );
    },
  );
});

it("auto-compact triggers when inputTokenCount breaches the supervisor threshold", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // inputTokenCount lags one turn (it is populated post-flight), so set the
    // mock high before the first turn. The first turn has no supervisor yet,
    // so it never compacts regardless of the count.
    driver.mockAnthropic.mockClient.mockInputTokenCount = 170_000;

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

    const originalThread = driver.magenta.chat.getActiveThread();

    // Wait for the first turn to settle and its post-flight token count to
    // populate inputTokenCount.
    await pollUntil(
      () => {
        const state = originalThread.agent.log;
        if (originalThread.agent.phase.type !== "idle")
          throw new Error("waiting for stop");
        if (
          state.inputTokenCount === undefined ||
          state.inputTokenCount < 160_000
        ) {
          throw new Error(
            `expected inputTokenCount >= 160000 but got ${state.inputTokenCount}`,
          );
        }
      },
      { timeout: 2000, message: "inputTokenCount should be populated" },
    );

    // Auto-compact is now a supervisor concern. Attach one (after the first
    // turn's handoff already ran) with a threshold below the current count and
    // a configured nextPrompt so the next handoff triggers compaction.
    originalThread.supervisors = [
      new AutoCompactSupervisor({
        threshold: 160_000,
        nextPrompt: "Now help me with multiplication",
      }),
    ];

    // The next send consults the supervisor before its opening request, so the
    // over-threshold token count compacts instead of issuing that request.
    await driver.inputMagentaText("Another question");
    await driver.send();

    // The thread should enter compacting mode automatically
    await pollUntil(
      () => {
        if (!isCompacting(originalThread))
          throw new Error("expected the thread to be compacting");
      },
      { timeout: 2000, message: "thread should auto-compact" },
    );

    if (!isCompacting(originalThread)) throw new Error("expected compacting");

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
        (c): c is Extract<typeof c, { type: "text" | "context_update" }> =>
          c.type === "text" || c.type === "context_update",
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

    yieldChunk(afterEdlStream);

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

it("auto-compact uses the configured next prompt from options", async () => {
  const customNextPrompt = "CUSTOM_NEXT_PROMPT_XYZ do the follow-up work";
  await withDriver(
    {
      options: {
        autoCompactThreshold: 160_000,
        autoCompactPrompt: customNextPrompt,
      },
    },
    async (driver) => {
      await driver.showSidebar();

      driver.mockAnthropic.mockClient.mockInputTokenCount = 170_000;

      await driver.inputMagentaText("What is 2+2?");
      await driver.send();

      const originalThread = driver.magenta.chat.getActiveThread();

      // Drive turns until the post-flight inputTokenCount is populated and the
      // handoff triggers auto-compaction.
      let compactSubagentStream: Awaited<
        ReturnType<typeof driver.mockAnthropic.awaitPendingStream>
      > | null = null;
      for (let i = 0; i < 5; i++) {
        const stream = await driver.mockAnthropic.awaitPendingStream({
          message: `turn ${i}`,
        });
        if (isCompacting(originalThread)) {
          compactSubagentStream = stream;
          break;
        }
        stream.respond({
          stopReason: "end_turn",
          text: "working on it",
          toolRequests: [],
        });
      }

      if (!compactSubagentStream)
        throw new Error("thread did not auto-compact");

      const subagentMessages = compactSubagentStream.getProviderMessages();
      const userMsg = subagentMessages.find((m) => m.role === "user");
      expect(userMsg).toBeDefined();
      const textContent = userMsg!.content
        .filter(
          (c): c is Extract<typeof c, { type: "text" | "context_update" }> =>
            c.type === "text" || c.type === "context_update",
        )
        .map((c) => c.text)
        .join("");
      expect(textContent).toContain("CUSTOM_NEXT_PROMPT_XYZ");
    },
  );
});

it("script-spawned thread honors per-thread autoCompactPrompt override", async () => {
  const customNextPrompt = "PER_THREAD_NEXT_PROMPT_QRS finish the migration";
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    driver.mockAnthropic.mockClient.mockInputTokenCount = 170_000;

    const threadId = await driver.magenta.chat.spawnScriptThread({
      scriptInvocationId: "inv-prompt-override" as ScriptInvocationId,
      scriptName: "test-script",
      prompt: "do the work",
      yieldSchema: { type: "object", properties: {} },
      getSandboxRoot: () => undefined,
      autoCompactThreshold: 160_000,
      autoCompactPrompt: customNextPrompt,
    });

    const wrapper = driver.magenta.chat.threadWrappers[threadId];
    if (wrapper.state !== "initialized")
      throw new Error("expected initialized thread");
    const thread = wrapper.thread;

    // Drive turns until the post-flight inputTokenCount is populated and the
    // handoff triggers auto-compaction. Once the thread enters compacting mode,
    // the next pending stream is the compaction subagent stream (which we must
    // not respond to as an ordinary turn).
    let compactSubagentStream: Awaited<
      ReturnType<typeof driver.mockAnthropic.awaitPendingStream>
    > | null = null;
    for (let i = 0; i < 5; i++) {
      const stream = await driver.mockAnthropic.awaitPendingStream({
        message: `script thread turn ${i}`,
      });
      if (isCompacting(thread)) {
        compactSubagentStream = stream;
        break;
      }
      stream.respond({
        stopReason: "end_turn",
        text: "working on it",
        toolRequests: [],
      });
    }

    if (!compactSubagentStream)
      throw new Error("script thread did not auto-compact");

    const subagentMessages = compactSubagentStream.getProviderMessages();
    const userMsg = subagentMessages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const textContent = userMsg!.content
      .filter(
        (c): c is Extract<typeof c, { type: "text" | "context_update" }> =>
          c.type === "text" || c.type === "context_update",
      )
      .map((c) => c.text)
      .join("");
    expect(textContent).toContain("PER_THREAD_NEXT_PROMPT_QRS");
  });
});

it("script-spawned thread without prompt override falls back to the default template", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    driver.mockAnthropic.mockClient.mockInputTokenCount = 170_000;

    const threadId = await driver.magenta.chat.spawnScriptThread({
      scriptInvocationId: "inv-no-override" as ScriptInvocationId,
      scriptName: "test-script",
      prompt: "do the work",
      yieldSchema: { type: "object", properties: {} },
      getSandboxRoot: () => undefined,
      autoCompactThreshold: 160_000,
    });

    const wrapper = driver.magenta.chat.threadWrappers[threadId];
    if (wrapper.state !== "initialized")
      throw new Error("expected initialized thread");
    const thread = wrapper.thread;

    let compactSubagentStream: Awaited<
      ReturnType<typeof driver.mockAnthropic.awaitPendingStream>
    > | null = null;
    for (let i = 0; i < 5; i++) {
      const stream = await driver.mockAnthropic.awaitPendingStream({
        message: `script thread turn ${i}`,
      });
      if (isCompacting(thread)) {
        compactSubagentStream = stream;
        break;
      }
      stream.respond({
        stopReason: "end_turn",
        text: "working on it",
        toolRequests: [],
      });
    }

    if (!compactSubagentStream)
      throw new Error("script thread did not auto-compact");

    const subagentMessages = compactSubagentStream.getProviderMessages();
    const userMsg = subagentMessages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    const textContent = userMsg!.content
      .filter(
        (c): c is Extract<typeof c, { type: "text" | "context_update" }> =>
          c.type === "text" || c.type === "context_update",
      )
      .map((c) => c.text)
      .join("");
    expect(textContent).not.toContain("PER_THREAD_NEXT_PROMPT_QRS");
    expect(textContent).toContain("working brief");
    expect(textContent).toContain(
      "before the conversation was automatically compacted",
    );
  });
});

it("spawns one compact child thread per chunk, carrying the summary forward", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Build up a very large conversation to produce multiple chunks.
    // TARGET_CHUNK_TOKENS=25000, CHARS_PER_TOKEN=4 → targetChunkChars=100000
    // We need >100K chars total for 2+ chunks.
    const longText = "x".repeat(60_000);

    await driver.inputMagentaText("First question");
    await driver.send();

    const r1 = await driver.mockAnthropic.awaitPendingStream({
      message: "r1",
    });
    r1.respond({
      stopReason: "end_turn",
      text: `Answer 1: ${longText}`,
      toolRequests: [],
    });

    await driver.inputMagentaText("Second question");
    await driver.send();

    const r2 = await driver.mockAnthropic.awaitPendingStream({
      message: "r2",
    });
    r2.respond({
      stopReason: "end_turn",
      text: `Answer 2: ${longText}`,
      toolRequests: [],
    });

    const thread = driver.magenta.chat.getActiveThread();
    expect(finishedRuns(thread)).toHaveLength(0);

    // Trigger compaction
    await driver.inputMagentaText("@compact Continue with next task");
    await driver.send();

    await pollUntil(
      () => {
        if (!isCompacting(thread))
          throw new Error("expected the thread to be compacting");
      },
      { timeout: 2000, message: "thread should enter compacting mode" },
    );

    // Verify we got multiple chunks
    if (!isCompacting(thread)) throw new Error("not compacting");
    const totalChunks = compactorOf(thread).current!.totalChunks;
    expect(totalChunks).toBeGreaterThanOrEqual(2);

    // === Process chunk 1 ===
    const chunk1Stream = await driver.mockAnthropic.awaitPendingStream({
      message: "compact chunk 1",
    });

    // Verify chunk 1 prompt contains the chunk content
    const chunk1Messages = chunk1Stream.getProviderMessages();
    const chunk1UserMsg = chunk1Messages.find((m) => m.role === "user");
    expect(chunk1UserMsg).toBeDefined();
    const chunk1Text = chunk1UserMsg!.content
      .filter(
        (c): c is Extract<typeof c, { type: "text" | "context_update" }> =>
          c.type === "text" || c.type === "context_update",
      )
      .map((c) => c.text)
      .join("");
    expect(chunk1Text).toContain("chunk 1 of");

    const edlScript1 = `file \`/summary.md\`\nselect bof-eof\nreplace <<COMPACT_SUMMARY\n# Summary\nFirst chunk processed: user asked two questions about large texts.\nCOMPACT_SUMMARY`;

    chunk1Stream.respond({
      stopReason: "tool_use",
      text: "Processing chunk 1.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "edl_chunk1" as ToolRequestId,
            toolName: "edl" as ToolName,
            input: { script: edlScript1 },
          },
        },
      ],
    });

    const afterEdl1 = await driver.mockAnthropic.awaitPendingStream({
      message: "compact after EDL chunk 1",
    });
    yieldChunk(afterEdl1);

    // === Process chunk 2 ===
    const chunk2Stream = await driver.mockAnthropic.awaitPendingStream({
      message: "compact chunk 2",
    });

    // Verify chunk 2 prompt references the existing summary
    const chunk2Messages = chunk2Stream.getProviderMessages();
    const chunk2UserMsg = chunk2Messages.find((m) => m.role === "user");
    expect(chunk2UserMsg).toBeDefined();
    const chunk2Text = chunk2UserMsg!.content
      .filter(
        (c): c is Extract<typeof c, { type: "text" | "context_update" }> =>
          c.type === "text" || c.type === "context_update",
      )
      .map((c) => c.text)
      .join("");
    expect(chunk2Text).toContain("chunk 2 of");
    // Chunk 2's prompt carries chunk 1's summary, not chunk 1's transcript.
    expect(chunk2Text).toContain("First chunk processed");
    // Two chunk threads so far, and they are children of the parent thread.
    expect(compactionRunThreadIds(compactorOf(thread).current!)).toHaveLength(
      2,
    );

    const edlScript2 = `file \`/summary.md\`\nselect bof-eof\nreplace <<COMPACT_SUMMARY\n# Summary\nUser asked two questions. Both answers were very long.\nCOMPACT_SUMMARY`;

    chunk2Stream.respond({
      stopReason: "tool_use",
      text: "Processing chunk 2.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "edl_chunk2" as ToolRequestId,
            toolName: "edl" as ToolName,
            input: { script: edlScript2 },
          },
        },
      ],
    });

    const afterEdl2 = await driver.mockAnthropic.awaitPendingStream({
      message: "compact after EDL chunk 2",
    });
    yieldChunk(afterEdl2);

    // If there are more chunks, process them the same way
    // For safety, drain any remaining chunks
    for (let i = 2; i < totalChunks; i++) {
      const extraStream = await driver.mockAnthropic.awaitPendingStream({
        message: `compact chunk ${i + 1}`,
      });
      const edlExtra = `file \`/summary.md\`\nselect bof-eof\nreplace <<COMPACT_SUMMARY\n# Summary\nUser asked two questions. Both answers were very long.\nCOMPACT_SUMMARY`;
      extraStream.respond({
        stopReason: "tool_use",
        text: `Processing chunk ${i + 1}.`,
        toolRequests: [
          {
            status: "ok",
            value: {
              id: `edl_chunk${i + 1}` as ToolRequestId,
              toolName: "edl" as ToolName,
              input: { script: edlExtra },
            },
          },
        ],
      });
      const afterEdlExtra = await driver.mockAnthropic.awaitPendingStream({
        message: `compact after EDL chunk ${i + 1}`,
      });
      yieldChunk(afterEdlExtra);
    }

    // After all chunks, the parent thread should resume
    const afterCompactStream = await driver.mockAnthropic.awaitPendingStream({
      message: "after compact continuation",
    });
    afterCompactStream.respond({
      stopReason: "end_turn",
      text: "Ready for the next task!",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("Ready for the next task!");

    // === Verify compaction history ===
    expect(finishedRuns(thread)).toHaveLength(1);
    const record = finishedRuns(thread)[0];
    if (record.type !== "done") throw new Error("expected a completed run");
    // One child thread per chunk, each a real thread the user can open.
    expect(record.threadIds).toHaveLength(totalChunks);
    expect(record.summary).toContain("Summary");
    for (const threadId of record.threadIds) {
      const wrapper = driver.magenta.chat.threadWrappers[threadId];
      if (wrapper?.state !== "initialized")
        throw new Error("expected the chunk thread to still be around");
      expect(wrapper.thread.core.state.threadType).toBe("compact");
      expect(wrapper.parentThreadId).toBe(thread.id);
    }

    // Verify the compaction history view is renderable in the display
    await driver.assertDisplayBufferContains("📦 [Compaction 1");
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
        const tokenCount =
          driver.magenta.chat.getActiveThread().agent.log.inputTokenCount;
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
        if (!isCompacting(originalThread))
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
    expect(isCompacting(originalThread)).toBe(true);

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
    yieldChunk(afterEdlStream);

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

it("compact keeps context files after compaction", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        await fs.writeFile(
          path.join(tmpDir, "context-file.ts"),
          "export const x = 1;",
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Add a context file
      await driver.inputMagentaText("@file:context-file.ts Hello");
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingStream({
        message: "initial request",
      });
      request1.respond({
        stopReason: "end_turn",
        text: "I see the file.",
        toolRequests: [],
      });

      const thread = driver.magenta.chat.getActiveThread();

      await pollUntil(() => {
        const files = Object.keys(thread.contextManager.files);
        if (files.length < 1) throw new Error("expected 1 file");
      });

      expect(Object.keys(thread.contextManager.files)).toHaveLength(1);

      // Trigger compaction
      await driver.inputMagentaText("@compact Continue working");
      await driver.send();

      await pollUntil(
        () => {
          if (!isCompacting(thread)) throw new Error("expected compacting");
        },
        { timeout: 2000 },
      );

      const compactStream = await driver.mockAnthropic.awaitPendingStream({
        message: "compact subagent",
      });

      const edlScript = [
        "file `/summary.md`",
        "select bof-eof",
        "replace <<COMPACT_SUMMARY",
        "# Summary",
        "User added context-file.ts and asked hello.",
        "COMPACT_SUMMARY",
      ].join("\n");

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
        message: "after EDL",
      });
      yieldChunk(afterEdlStream);

      const afterCompactStream = await driver.mockAnthropic.awaitPendingStream({
        message: "after compact",
      });
      afterCompactStream.respond({
        stopReason: "end_turn",
        text: "Starting fresh!",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContains("Starting fresh!");

      // The context manager is a thread-level collaborator and survives the
      // agent swap, so the user's context files are still watched.
      expect(Object.keys(thread.contextManager.files)).toHaveLength(1);
    },
  );
});

it("compaction keeps reminders derived from files still tracked in context", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        await fs.writeFile(
          path.join(tmpDir, "ctx.md"),
          "# Ctx\n\n<system_reminder>\ncontext cat reminder\n</system_reminder>\n",
        );
        await fs.writeFile(
          path.join(tmpDir, "transient.md"),
          "# Transient\n\n<system_reminder>\ntransient cat reminder\n</system_reminder>\n",
        );
      },
    },
    async (driver) => {
      await driver.showSidebar();
      await driver.magenta.command("context-files './ctx.md'");

      await driver.inputMagentaText("Use a skill");
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.respond({
        stopReason: "tool_use",
        text: "reading the transient skill",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "tool_1" as ToolRequestId,
              toolName: "get_files" as ToolName,
              input: { files: [{ filePath: "./transient.md" }] },
            },
          },
        ],
        usage: { inputTokens: 100, outputTokens: 5000 },
      });

      const autoRespond = await driver.mockAnthropic.awaitPendingStream();
      autoRespond.respond({
        stopReason: "end_turn",
        text: "done reading",
        toolRequests: [],
      });

      await driver.inputMagentaText("@compact continue please");
      await driver.send();

      const compactSubagentStream =
        await driver.mockAnthropic.awaitPendingStream({
          message: "compact subagent stream",
        });
      const edlScript = `file \`/summary.md\`\nselect bof-eof\nreplace <<COMPACT_SUMMARY\n# Summary\nread skills\nCOMPACT_SUMMARY`;
      compactSubagentStream.respond({
        stopReason: "tool_use",
        text: "compacting",
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
      yieldChunk(afterEdlStream);

      const afterCompactStream = await driver.mockAnthropic.awaitPendingStream({
        message: "after compact continuation",
      });
      const lastMessage =
        afterCompactStream.messages[afterCompactStream.messages.length - 1];
      if (typeof lastMessage.content === "string") {
        throw new Error("Expected array content");
      }
      const reminder = lastMessage.content.find(
        (c) => c.type === "text" && c.text.includes("<system-reminder>"),
      );
      expect(reminder).toBeDefined();
      if (reminder && reminder.type === "text") {
        // Compaction clears the transient `activeReminders` set, but the
        // context manager survives the agent swap, so reminders derived from
        // the files it still tracks (both the explicitly added one and the
        // one a get_files read pulled in) are re-derived.
        expect(reminder.text).toContain("context cat reminder");
        expect(reminder.text).toContain("transient cat reminder");
      }

      afterCompactStream.respond({
        stopReason: "end_turn",
        text: "all set",
        toolRequests: [],
      });
    },
  );
});

it("deleting the compact child thread aborts the parked submission", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
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
    await driver.inputMagentaText("@compact");
    await driver.send();

    await pollUntil(
      () => {
        if (!isCompacting(thread)) throw new Error("expected compacting");
      },
      { timeout: 2000, message: "thread should spawn a chunk thread" },
    );

    const chunkThreadId = compactorOf(thread).current!.activeThreadId;
    driver.magenta.chat.deleteThread(chunkThreadId);

    await pollUntil(
      () => {
        const runs = finishedRuns(thread);
        if (runs.length !== 1) throw new Error("expected the run to settle");
        if (runs[0].type !== "aborted")
          throw new Error(`expected aborted, got ${runs[0].type}`);
      },
      { timeout: 2000, message: "deleting the child should abort the run" },
    );
    // The parent is idle again: nothing is waiting on the deleted thread.
    expect(isCompacting(thread)).toBe(false);
    expect(thread.agent.phase.type).toBe("idle");
  });
});

it("fails the parked submission when the chunk thread yields an empty summary", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
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
    await driver.inputMagentaText("@compact");
    await driver.send();

    const compactStream = await driver.mockAnthropic.awaitPendingStream({
      message: "compact subagent stream",
    });
    // The chunk thread yields without ever writing /summary.md.
    yieldChunk(compactStream);

    await pollUntil(
      () => {
        const runs = finishedRuns(thread);
        if (runs.length !== 1) throw new Error("expected the run to settle");
        if (runs[0].type !== "error")
          throw new Error(`expected error, got ${runs[0].type}`);
      },
      { timeout: 2000, message: "an empty summary should settle as an error" },
    );

    // The submission settles rather than hanging: no continuation request is
    // issued and the thread is idle again.
    expect(isCompacting(thread)).toBe(false);
    await pollUntil(
      () => {
        if (thread.agent.phase.type !== "idle")
          throw new Error("waiting for the parent thread to settle");
      },
      { timeout: 2000, message: "parent thread should settle" },
    );
    await driver.assertDisplayBufferContains(
      "the compaction finished but /summary.md is empty",
    );
  });
});

it("discards an in-flight run when a fresh @compact arrives", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
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
    await driver.inputMagentaText("@compact");
    await driver.send();

    await pollUntil(
      () => {
        if (!isCompacting(thread)) throw new Error("expected compacting");
      },
      { timeout: 2000, message: "thread should spawn a chunk thread" },
    );
    const firstChunkThreadId = compactorOf(thread).current!.activeThreadId;

    // A second @compact while the first run's chunk thread is still pending.
    await driver.inputMagentaText("@compact");
    await driver.send();

    await pollUntil(
      () => {
        const runs = finishedRuns(thread);
        if (runs.length !== 1)
          throw new Error("expected the first run to settle");
        if (runs[0].type !== "aborted")
          throw new Error(`expected aborted, got ${runs[0].type}`);
        if (!isCompacting(thread)) throw new Error("expected a second run");
        const current = compactorOf(thread).current!;
        if (current.activeThreadId === firstChunkThreadId)
          throw new Error("expected a fresh chunk thread");
      },
      { timeout: 5000, message: "a fresh @compact should discard the old run" },
    );

    // The discarded run's chunk thread is gone.
    expect(
      driver.magenta.chat.threadWrappers[firstChunkThreadId],
    ).toBeUndefined();
  });
});

it("delivers @compact typed into a compact thread as ordinary text", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
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
    await driver.inputMagentaText("@compact");
    await driver.send();

    const compactStream = await driver.mockAnthropic.awaitPendingStream({
      message: "compact subagent stream",
    });
    compactStream.respondWithError(new Error("stall the chunk thread"));

    const chunkThreadId = compactorOf(thread).current!.activeThreadId;
    await pollUntil(
      () => {
        const wrapper = driver.magenta.chat.threadWrappers[chunkThreadId];
        if (wrapper?.state !== "initialized") throw new Error("waiting");
        if (wrapper.thread.agent.phase.type !== "idle")
          throw new Error("waiting for the chunk thread to settle");
      },
      { timeout: 5000, message: "chunk thread should settle" },
    );

    // The user walks into the chunk thread and types @compact there. A compact
    // thread has no compactor, so it is just text.
    driver.magenta.dispatch({
      type: "chat-msg",
      msg: { type: "set-active-thread", id: chunkThreadId },
    });
    await driver.inputMagentaText("@compact foo");
    await driver.send();

    const retryStream = await driver.mockAnthropic.awaitPendingStream({
      message: "chunk thread after @compact text",
    });
    const messages = retryStream.getProviderMessages();
    const text = messages
      .flatMap((m) =>
        m.content
          .filter(
            (c): c is Extract<typeof c, { type: "text" }> => c.type === "text",
          )
          .map((c) => c.text),
      )
      .join("\n");
    expect(text).toContain("@compact foo");

    // No nested compaction was started.
    const chunkWrapper = driver.magenta.chat.threadWrappers[chunkThreadId];
    expect(
      chunkWrapper?.state === "initialized" && chunkWrapper.thread.compactor,
    ).toBeUndefined();
  });
});
