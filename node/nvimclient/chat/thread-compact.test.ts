import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/server";
import { compactionRunThreadIds, type ThreadCompactor } from "@magenta/server";
import { expect, it } from "vitest";
import type { MockStream } from "../providers/mock-anthropic-client.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";
import { notificationLog, resetNotificationLog } from "./notify.ts";
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
      if (originalThread.thread.getProviderMessages().length >= 4) return true;
      throw new Error("waiting for messages");
    });

    await pollUntil(() => {
      if (originalThread.thread.state.type === "running")
        throw new Error("waiting for rest");
    });
    resetNotificationLog();
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

    expect(
      notificationLog.filter(
        (entry) => entry.reason === "thread-submission-end",
      ),
    ).toHaveLength(0);
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
    await pollUntil(() => {
      expect(
        notificationLog.filter(
          (entry) => entry.reason === "thread-submission-end",
        ),
      ).toHaveLength(1);
    });
    const nested = path.join(originalThread.context.cwd, "after-compact");
    await fs.mkdir(nested);
    await fs.writeFile(
      path.join(nested, "context.md"),
      "hierarchy discovered after compaction",
    );
    await fs.writeFile(path.join(nested, "leaf.txt"), "new leaf contents");
    await driver.addContextFiles("after-compact/leaf.txt");
    await pollUntil(() => {
      expect(Object.keys(originalThread.thread.contextFiles.files)).toContain(
        path.join(nested, "context.md"),
      );
    });
    await driver.inputMagentaText("Read @file:after-compact/leaf.txt");
    await driver.send();
    const withHierarchy = await driver.mockAnthropic.awaitPendingStream();
    expect(JSON.stringify(withHierarchy.messages)).toContain(
      "hierarchy discovered after compaction",
    );
    expect(JSON.stringify(withHierarchy.messages)).toContain(
      "new leaf contents",
    );
    withHierarchy.respond({
      stopReason: "end_turn",
      text: "Hierarchy received",
      toolRequests: [],
    });
    await driver.assertDisplayBufferContains("after-compact/context.md");
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
      expect(wrapper.thread.thread.threadType).toBe("compact");
      expect(wrapper.parentThreadId).toBe(thread.id);
    }

    // Verify the compaction history view is renderable in the display
    await driver.assertDisplayBufferContains("📦 [Compaction 1");
  });
});
