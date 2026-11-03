// biome-ignore-all lint/complexity/useLiteralKeys: White-box test: the view adapter is rebuilt over an existing session.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ABORTED,
  parseOptions,
  type ThreadId,
  type ToolName,
  type ToolRequestId,
} from "@magenta/server";
import { MockSandboxManager } from "@magenta/server/src/test/mock-sandbox-manager.ts";
import { noopLogger } from "@magenta/server/src/test-helpers.ts";
import type { HomeDir } from "@magenta/server/src/utils/files.ts";
import { expect, it } from "vitest";
import type { Lsp } from "../capabilities/lsp.ts";
import { startInProcessServer } from "../in-process-server.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import { type MagentaOptions, parseClientOptions } from "../options.ts";
import { type MockProvider, withMockClient } from "../providers/mock.ts";
import {
  leftThread,
  registerServerSession,
  serverThread,
} from "../test/left-thread.ts";
import type { NvimCwd } from "../utils/files.ts";
import { Chat } from "./chat.ts";

/** A Chat over an in-process server with no nvim: the view adapter only
 * touches nvim for logging. */
async function withChat(
  fn: (env: {
    chat: Chat;
    internals: ReturnType<typeof startInProcessServer>["internals"];
    mock: MockProvider;
    newChat: () => Chat;
  }) => Promise<void>,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chat-view-adapter-"));
  const options = {
    ...parseOptions(
      { profiles: [{ name: "mock", provider: "mock", model: "mock" }] },
      noopLogger,
    ),
    ...parseClientOptions({}, noopLogger),
  } as MagentaOptions;
  const sandbox = new MockSandboxManager();
  const started = startInProcessServer({
    logger: noopLogger,
    cwd: dir as never,
    homeDir: dir as HomeDir,
    sandbox,
    getBaseOptions: () => options,
    getScriptsPaths: () => [],
  });
  const newChat = () => {
    const chat: Chat = new Chat(
      {
        dispatch: (msg) => chat.update(msg),
        getDisplayWidth: () => 100,
        getOptions: () => options,
        cwd: dir as NvimCwd,
        homeDir: dir as HomeDir,
        nvim: { logger: noopLogger } as unknown as Nvim,
        lsp: {} as Lsp,
        sandbox,
        removeArchivedThreadBuffers: () => {},
      },
      {
        sessionId: started.sessionId,
        host: started.host,
        server: started.server,
        scriptRunner: started.scriptRunner,
      },
    );
    registerServerSession(chat, started.internals.session);
    return chat;
  };
  try {
    await withMockClient(async (mock) => {
      const chat = newChat();
      const id = await chat.createThread({ type: "thread.create" });
      if (id === ABORTED) throw new Error("aborted");
      chat.update({
        type: "chat-msg",
        msg: { type: "set-active-thread", id },
      });
      await fn({ chat, internals: started.internals, mock, newChat });
    });
  } finally {
    await started.server.dispose().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

it("rebuilding the view adapter over an existing session makes no new thread or title request", async () => {
  await withChat(async ({ chat, mock, newChat }) => {
    const liveThread = serverThread(leftThread(chat));
    const submitted = liveThread.submit({
      type: "resolved",
      messages: [{ type: "text", text: "Tell me about the solar system" }],
    });
    await mock.awaitPendingForceToolUseRequest();
    await mock.respondToForceToolUse({
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
    const request = await mock.awaitPendingStream();
    request.streamText("The sun is large.");
    request.finishResponse("end_turn");
    await submitted;

    const threadId = liveThread.id;
    const titleRequests = mock.forceToolUseRequests.length;
    const rebuilt = newChat();

    // The rebuilt view sees the same registry, wrapping the same server Thread.
    expect(Object.keys(rebuilt.threadWrappers)).toEqual([threadId]);
    const wrapper = rebuilt.threadWrappers[threadId];
    if (wrapper?.state !== "initialized") throw new Error("not initialized");
    expect(serverThread(wrapper.thread)).toBe(liveThread);
    await expect
      .poll(() => rebuilt.getThreadDisplayName(threadId))
      .toBe("Solar system");

    // No second Thread was constructed, and no second title was requested.
    expect(chat.session.listThreads().length).toBe(1);
    expect(mock.forceToolUseRequests.length).toBe(titleRequests);
  });
});

it("a turn completes with no view listener attached to the session", async () => {
  await withChat(async ({ chat, internals, mock }) => {
    const thread = serverThread(leftThread(chat));
    // Detach every observer: execution must not depend on one.
    internals.session.removeAllListeners();
    const submitted = thread.submit({
      type: "resolved",
      messages: [{ type: "text", text: "hello with no view" }],
    });
    const request = await mock.awaitPendingStream();
    request.streamText("response with no view");
    request.finishResponse("end_turn");
    expect((await submitted).type).toBe("completed");
    expect(chat.session.getThread(thread.id)?.state).toBe("ready");
  });
});

it("renders an initialized record whose view has not been built as initializing", async () => {
  await withChat(async ({ chat }) => {
    const threadId = leftThread(chat).id;
    // Drop the view-local wrapper while the session record stays initialized:
    // the same window a change event that has not been observed yet leaves.
    chat["threadViews"].get(threadId)?.dispose();
    chat["threadViews"].delete(threadId);
    expect(chat.threadWrappers[threadId]?.state).toBe("view-pending");
    expect(chat.getThreadSummary(threadId).status.type).toBe("pending");
  });
});

it("a thread that fails to construct takes the view out of thread-selected", async () => {
  await withChat(async ({ chat, internals }) => {
    expect(chat.state.state).toBe("thread-selected");
    chat.host.prepareThread = () => ({
      promise: Promise.reject(new Error("preparation exploded")),
      abort: () => {},
    });
    await expect(internals.session.createRootThread()).rejects.toThrow(
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
  await withChat(async ({ chat, internals }) => {
    const session = internals.session;
    const existingId = leftThread(chat).id;
    chat.dispose();
    expect(chat["threadViews"].size).toBe(0);
    // Session mutations after dispose must not repopulate the view cache.
    const newId = await session.createRootThread();
    if (newId === ABORTED) throw new Error("thread creation was aborted");
    expect(chat["threadViews"].size).toBe(0);
    session.deleteThread(newId);
    session.deleteThread(existingId);
    expect(chat["threadViews"].size).toBe(0);
  });
});

it("deleting a thread drops its wrapper and view but keeps siblings", async () => {
  await withChat(async ({ chat }) => {
    const first = leftThread(chat).id;
    const second = await chat.createThread({ type: "thread.create" });
    if (second === ABORTED) throw new Error("aborted");
    expect(Object.keys(chat.threadWrappers).sort()).toEqual(
      [first, second].sort(),
    );
    await chat.deleteThread(second);
    expect(Object.keys(chat.threadWrappers)).toEqual([first]);
    const views = chat["threadViews"];
    expect(views.has(second)).toBe(false);
    expect(views.has(first)).toBe(true);
    expect(chat.threadWrappers[first]?.state).toBe("initialized");
  });
});

it("chat.execute rejects with the message of an error result", async () => {
  await withChat(async ({ chat }) => {
    await expect(
      chat.execute({
        type: "session.setActiveProfile",
        sessionId: chat.sessionId,
        name: "missing",
      }),
    ).rejects.toThrow('Profile "missing" not found.');
    await expect(
      chat.execute({ type: "thread.delete", threadId: "nope" as ThreadId }),
    ).rejects.toThrow();
  });
});
