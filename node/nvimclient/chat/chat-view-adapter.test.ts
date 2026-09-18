// biome-ignore-all lint/complexity/useLiteralKeys: White-box test: the view adapter is rebuilt over an existing session.
import {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ThreadId,
  type ToolName,
  type ToolRequestId,
} from "@magenta/server";
import { expect, it } from "vitest";
import { withDriver } from "../test/preamble.ts";
import { Chat } from "./chat.ts";

it("rebuilding the view adapter over an existing session makes no new thread or title request", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Tell me about the solar system");
    await driver.send();

    await driver.mockAnthropic.awaitPendingForceToolUseRequest();
    await driver.mockAnthropic.respondToForceToolUse({
      stopReason: "tool_use",
      toolRequest: {
        status: "ok",
        value: {
          id: "id" as ToolRequestId,
          toolName: "thread_title" as ToolName,
          input: { title: "Solar system" },
        },
      },
    });
    const request = await driver.mockAnthropic.awaitPendingStream();
    request.streamText("The sun is large.");
    request.finishResponse("end_turn");
    await driver.assertDisplayBufferContains("The sun is large.");

    const chat = driver.magenta.chat;
    if (chat.state.state !== "thread-selected")
      throw new Error("expected a selected thread");
    const threadId = chat.state.activeThreadId;
    const serverThread = chat.getActiveThread().thread;
    const titleRequests = driver.mockAnthropic.forceToolUseRequests.length;

    const rebuilt = new Chat(chat.context, {
      session: chat.session,
      host: chat.host,
    });

    // The rebuilt view sees the same registry, wrapping the same server Thread.
    expect(Object.keys(rebuilt.threadWrappers)).toEqual([threadId]);
    const wrapper = rebuilt.threadWrappers[threadId];
    expect(wrapper?.state).toBe("initialized");
    if (wrapper?.state !== "initialized") throw new Error("not initialized");
    expect(wrapper.thread.thread).toBe(serverThread);
    expect(rebuilt.getThreadDisplayName(threadId)).toBe("Solar system");

    // No second Thread was constructed, and no second title was requested.
    expect(chat.session.listThreads().length).toBe(1);
    expect(driver.mockAnthropic.forceToolUseRequests.length).toBe(
      titleRequests,
    );
  });
});

it("a turn completes with no view listener attached to the session", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const chat = driver.magenta.chat;
    const thread = chat.getActiveThread().thread;

    // Detach every observer: execution must not depend on one.
    chat.session.removeAllListeners();

    const submitted = thread.submit({
      type: "resolved",
      messages: [
        {
          type: "text",
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          text: "hello with no view",
        },
      ],
    });
    const request = await driver.mockAnthropic.awaitPendingStream();
    request.streamText("response with no view");
    request.finishResponse("end_turn");

    const result = await submitted;
    expect(result.type).toBe("completed");
    expect(chat.session.getThread(thread.id as ThreadId)?.state).toBe(
      "initialized",
    );
  });
});

it("renders an initialized record whose view has not been built as initializing", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const chat = driver.magenta.chat;
    const threadId = chat.getActiveThread().id;
    // Drop the view-local wrapper while the session record stays initialized:
    // the same window a change event that has not been observed yet leaves.
    chat["threadViews"].get(threadId)?.dispose();
    chat["threadViews"].delete(threadId);
    expect(chat.threadWrappers[threadId]?.state).toBe("view-pending");
    expect(chat.getThreadSummary(threadId).status.type).toBe("pending");
  });
});

it("a thread that fails to construct takes the view out of thread-selected", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const chat = driver.magenta.chat;
    expect(chat.state.state).toBe("thread-selected");
    chat.host.prepareThread = () =>
      Promise.reject(new Error("preparation exploded"));
    await expect(chat.session.createRootThread()).rejects.toThrow(
      "preparation exploded",
    );
    expect(chat.state.state).toBe("thread-overview");
    const failedId = chat.session
      .listThreads()
      .find((record) => record.state === "error")?.id;
    if (!failedId) throw new Error("expected an error record");
    expect(chat.threadWrappers[failedId]?.state).toBe("error");
  });
});

it("a disposed view observes no further session events", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const chat = driver.magenta.chat;
    const session = chat.session;
    const existingId = chat.getActiveThread().id;
    chat.dispose();
    expect(chat["threadViews"].size).toBe(0);
    // Session mutations after dispose must not repopulate the view cache.
    const newId = await session.createRootThread();
    expect(chat["threadViews"].size).toBe(0);
    session.deleteThread(newId);
    session.deleteThread(existingId);
    expect(chat["threadViews"].size).toBe(0);
  });
});
