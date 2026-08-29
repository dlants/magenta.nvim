import type { ThreadId, ToolName, ToolRequestId } from "@magenta/core";
import { expect, it } from "vitest";
import type { NvimDriver } from "../test/driver.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";
import type { NvimThread } from "./thread.ts";

const SUMMARY_EDL = `file \`/summary.md\`\nselect bof-eof\nreplace <<COMPACT_SUMMARY\n# Summary\nThe user and the assistant exchanged greetings.\nCOMPACT_SUMMARY`;

/** Get a thread with some history, then park it on a compaction whose single
 * chunk thread is waiting on its first stream. */
async function startCompaction(
  driver: NvimDriver,
): Promise<{ thread: NvimThread; chunkThreadId: ThreadId }> {
  await driver.showSidebar();
  await driver.inputMagentaText("Hello");
  await driver.send();
  const stream = await driver.mockAnthropic.awaitPendingStream({
    message: "initial request",
  });
  stream.respond({
    stopReason: "end_turn",
    text: "Hi there!",
    toolRequests: [],
  });

  const thread = driver.magenta.chat.getActiveThread();
  await driver.inputMagentaText("@compact");
  await driver.send();
  const chunkThreadId = await pollUntil(
    () => {
      const current = thread.compactor?.current;
      if (!current) throw new Error("waiting for the chunk thread to spawn");
      return current.activeThreadId;
    },
    { timeout: 2000, message: "compaction should start" },
  );
  return { thread, chunkThreadId };
}

/** Drive the pending chunk thread to completion: write /summary.md, yield. */
async function finishChunk(driver: NvimDriver): Promise<void> {
  const compactStream = await driver.mockAnthropic.awaitPendingStream({
    message: "compact chunk stream",
  });
  compactStream.respond({
    stopReason: "tool_use",
    text: "Compacting.",
    toolRequests: [
      {
        status: "ok",
        value: {
          id: "edl_1" as ToolRequestId,
          toolName: "edl" as ToolName,
          input: { script: SUMMARY_EDL },
        },
      },
    ],
  });
  const afterEdl = await driver.mockAnthropic.awaitPendingStream({
    message: "compact chunk after edl",
  });
  afterEdl.respond({
    stopReason: "tool_use",
    text: "Summary written.",
    toolRequests: [
      {
        status: "ok",
        value: {
          id: "yield_1" as ToolRequestId,
          toolName: "yield_to_parent" as ToolName,
          input: { result: "wrote /summary.md" },
        },
      },
    ],
  });
}

it("shows a live chunk counter that opens the chunk thread, then a history row", async () => {
  await withDriver({}, async (driver) => {
    const { thread, chunkThreadId } = await startCompaction(driver);

    await driver.assertDisplayBufferContains(
      "📦 Compacting thread... (chunk 1 / 1)",
    );

    // The status line is a way into the thread doing the work.
    await driver.triggerDisplayBufferKeyOnContent(
      "📦 Compacting thread... (chunk 1 / 1)",
      "<CR>",
    );
    await driver.awaitChatState({
      state: "thread-selected",
      id: chunkThreadId,
    });

    // That thread renders as a thread of its own, prompt and all.
    await driver.assertDisplayBufferContains("# compact 1/1");

    driver.magenta.dispatch({
      type: "select-thread-effect",
      id: thread.id,
    });
    await finishChunk(driver);

    const continuation = await driver.mockAnthropic.awaitPendingStream({
      message: "post-compaction continuation",
    });
    continuation.respond({
      stopReason: "end_turn",
      text: "Ready to continue!",
      toolRequests: [],
    });

    // The live counter gives way to a history row.
    await driver.assertDisplayBufferContains("📦 [Compaction 1 — 1 chunk");
    await driver.assertDisplayBufferDoesNotContain("📦 Compacting thread...");
  });
});

it("expands a history row and opens the chunk thread behind it", async () => {
  await withDriver({}, async (driver) => {
    const { thread, chunkThreadId } = await startCompaction(driver);
    await finishChunk(driver);
    const continuation = await driver.mockAnthropic.awaitPendingStream({
      message: "post-compaction continuation",
    });
    continuation.respond({
      stopReason: "end_turn",
      text: "Ready to continue!",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("📦 [Compaction 1 — 1 chunk");
    await driver.assertDisplayBufferDoesNotContain("📄 [chunk 1 of 1]");

    await driver.triggerDisplayBufferKeyOnContent(
      "📦 [Compaction 1 — 1 chunk",
      "=",
    );
    await driver.assertDisplayBufferContains("📄 [chunk 1 of 1]");
    await driver.assertDisplayBufferContains("📋 Final Summary:");

    // The history row survives navigating away and back.
    await driver.magenta.command("threads-overview");
    await driver.assertDisplayBufferContains("# Threads");
    driver.magenta.dispatch({
      type: "select-thread-effect",
      id: thread.id,
    });
    await driver.assertDisplayBufferContains("📄 [chunk 1 of 1]");

    await driver.triggerDisplayBufferKeyOnContent("📄 [chunk 1 of 1]", "<CR>");
    await driver.awaitChatState({
      state: "thread-selected",
      id: chunkThreadId,
    });
    await driver.assertDisplayBufferContains("Summary written.");

    // ...and collapses again.
    driver.magenta.dispatch({
      type: "select-thread-effect",
      id: thread.id,
    });
    await driver.triggerDisplayBufferKeyOnContent(
      "📦 [Compaction 1 — 1 chunk",
      "=",
    );
    await driver.assertDisplayBufferDoesNotContain("📄 [chunk 1 of 1]");
  });
});

it("renders an errored chunk thread as an ordinary thread, messageable in place", async () => {
  await withDriver({}, async (driver) => {
    const { thread, chunkThreadId } = await startCompaction(driver);

    const chunkStream = await driver.mockAnthropic.awaitPendingStream({
      message: "compact chunk stream",
    });
    chunkStream.respondWithError(new Error("chunk request blew up"));

    // The status line still points at the stuck thread, and that thread
    // renders its failure the way any other thread would.
    await driver.triggerDisplayBufferKeyOnContent(
      "📦 Compacting thread... (chunk 1 / 1)",
      "<CR>",
    );
    await driver.awaitChatState({
      state: "thread-selected",
      id: chunkThreadId,
    });
    await driver.assertDisplayBufferContains("chunk request blew up");

    // The user drives it home from its own view.
    await driver.inputMagentaText("try again");
    await driver.send();
    await finishChunk(driver);
    const continuation = await driver.mockAnthropic.awaitPendingStream({
      message: "post-compaction continuation",
    });
    continuation.respond({
      stopReason: "end_turn",
      text: "Back on track.",
      toolRequests: [],
    });

    driver.magenta.dispatch({
      type: "select-thread-effect",
      id: thread.id,
    });
    await driver.assertDisplayBufferContains("📦 [Compaction 1 — 1 chunk");
  });
});

it("nests the chunk threads under their parent in the thread overview", async () => {
  await withDriver({}, async (driver) => {
    const { chunkThreadId } = await startCompaction(driver);

    await driver.magenta.command("threads-overview");
    await driver.assertDisplayBufferContains("# Threads");
    await driver.assertDisplayBufferContains("(1 subthreads)");

    // The compact child is not a root row; it only shows once the parent is
    // expanded, indented beneath it.
    await driver.assertDisplayBufferDoesNotContain("- compact 1/1");
    await driver.triggerDisplayBufferKeyOnContent("(1 subthreads)", "=");
    await driver.assertDisplayBufferContains("  - compact 1/1");

    await driver.triggerDisplayBufferKeyOnContent("  - compact 1/1", "<CR>");
    await driver.awaitChatState({
      state: "thread-selected",
      id: chunkThreadId,
    });
  });
});

it("points the live status line at the chunk thread currently running", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    // >100K chars of transcript, so the compaction runs multiple chunks.
    const longText = "x".repeat(60_000);
    for (const [idx, question] of ["First", "Second"].entries()) {
      await driver.inputMagentaText(`${question} question`);
      await driver.send();
      const stream = await driver.mockAnthropic.awaitPendingStream({
        message: `answer ${idx + 1}`,
      });
      stream.respond({
        stopReason: "end_turn",
        text: `Answer ${idx + 1}: ${longText}`,
        toolRequests: [],
      });
    }

    const thread = driver.magenta.chat.getActiveThread();
    await driver.inputMagentaText("@compact");
    await driver.send();

    const firstChunkThreadId = await pollUntil(
      () => {
        const current = thread.compactor?.current;
        if (!current) throw new Error("waiting for the first chunk thread");
        return current.activeThreadId;
      },
      { timeout: 2000, message: "compaction should start" },
    );
    const totalChunks = thread.compactor!.current!.totalChunks;
    expect(totalChunks).toBeGreaterThanOrEqual(2);

    await finishChunk(driver);

    const secondChunkThreadId = await pollUntil(
      () => {
        const current = thread.compactor?.current;
        if (!current) throw new Error("expected the run to still be going");
        if (current.activeThreadId === firstChunkThreadId)
          throw new Error("waiting for the second chunk thread");
        return current.activeThreadId;
      },
      { timeout: 5000, message: "the second chunk thread should spawn" },
    );

    // The status line follows the chunk doing the work, not the first one.
    const statusLine = `📦 Compacting thread... (chunk 2 / ${totalChunks.toString()})`;
    await driver.assertDisplayBufferContains(statusLine);
    await driver.triggerDisplayBufferKeyOnContent(statusLine, "<CR>");
    await driver.awaitChatState({
      state: "thread-selected",
      id: secondChunkThreadId,
    });
  });
});
