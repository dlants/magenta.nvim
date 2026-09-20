import * as fs from "node:fs/promises";
import type { ThreadId, ToolName, ToolRequestId } from "@magenta/server";
import { flushArchive, threadConversationLogPath } from "@magenta/server";
import { v7 as uuidv7 } from "uuid";
import { expect, it } from "vitest";
import { withDriver } from "./test/preamble.ts";
import { pollUntil } from "./utils/async.ts";

it("thread display and input buffers are listed", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const threadId = driver.magenta.chat.getActiveThread().id;
    const buffers = driver.magenta.bufferManager.getThreadBuffers(threadId)!;
    expect(buffers).toBeDefined();

    const displayListed = await buffers.displayBuffer.getOption("buflisted");
    const inputListed = await buffers.inputBuffer.getOption("buflisted");
    expect(displayListed).toBe(true);
    expect(inputListed).toBe(true);
  });
});

it("setting a thread title renames both buffers", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const thread = driver.magenta.chat.getActiveThread();
    const threadId = thread.id;
    const buffers = driver.magenta.bufferManager.getThreadBuffers(threadId)!;

    thread.thread.setTitle("My Cool Title");

    await pollUntil(async () => {
      const displayName = (await driver.nvim.call("nvim_buf_get_name", [
        buffers.displayBuffer.id,
      ])) as string;
      if (!displayName.includes("My Cool Title")) {
        throw new Error(`display name not updated: ${displayName}`);
      }
    });

    const displayName = (await driver.nvim.call("nvim_buf_get_name", [
      buffers.displayBuffer.id,
    ])) as string;
    const inputName = (await driver.nvim.call("nvim_buf_get_name", [
      buffers.inputBuffer.id,
    ])) as string;
    expect(displayName).toContain("My Cool Title");
    expect(inputName).toContain("My Cool Title");
    // input name must still contain the completion-detection substring
    expect(inputName).toContain("Magenta Input");
    // names stay globally unique
    expect(displayName).not.toBe(inputName);
  });
});

it(":bd of a thread display buffer removes the thread", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const threadId = driver.magenta.chat.getActiveThread().id;
    const buffers = driver.magenta.bufferManager.getThreadBuffers(threadId)!;

    await driver.command(`bd! ${buffers.displayBuffer.id}`);

    await pollUntil(() => {
      if (threadId in driver.magenta.chat.threadWrappers) {
        throw new Error("thread still present");
      }
    });
    expect(threadId in driver.magenta.chat.threadWrappers).toBe(false);
    expect(driver.magenta.bufferManager.getThreadBuffers(threadId)).toBe(
      undefined,
    );
  });
});

it(":bd of a thread input buffer removes the thread", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const threadId = driver.magenta.chat.getActiveThread().id;
    const buffers = driver.magenta.bufferManager.getThreadBuffers(threadId)!;

    await driver.command(`bd! ${buffers.inputBuffer.id}`);

    await pollUntil(() => {
      if (threadId in driver.magenta.chat.threadWrappers) {
        throw new Error("thread still present");
      }
    });
    expect(threadId in driver.magenta.chat.threadWrappers).toBe(false);
  });
});

it("wiping an overview buffer does not remove threads and recovers", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const threadId: ThreadId = driver.magenta.chat.getActiveThread().id;
    const overview = driver.magenta.bufferManager.getOverviewBuffers();
    const oldDisplayId = overview.displayBuffer.id;

    await driver.command(`bwipeout! ${overview.displayBuffer.id}`);

    await pollUntil(() => {
      const fresh = driver.magenta.bufferManager.getOverviewBuffers();
      if (fresh.displayBuffer.id === oldDisplayId) {
        throw new Error("overview not recreated yet");
      }
    });

    // the thread is untouched
    expect(threadId in driver.magenta.chat.threadWrappers).toBe(true);

    // overview is re-mountable
    await driver.magenta.bufferManager.ensureOverviewMounted();
  });
});

it("archive list has a distinct listed display and shares the overview input", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.magenta.command("threads-overview");
    const overview = driver.magenta.bufferManager.getOverviewBuffers();

    await driver.triggerDisplayBufferKeyOnContent("[archive]", "<CR>");
    await driver.awaitChatState({ state: "archive" });

    const archive = driver.magenta.bufferManager.getArchiveBuffers();
    expect(archive.displayBuffer.id).not.toBe(overview.displayBuffer.id);
    expect(archive.inputBuffer.id).toBe(overview.inputBuffer.id);
    expect(await archive.displayBuffer.getOption("buflisted")).toBe(true);
    expect(driver.getDisplayBuffer().id).toBe(archive.displayBuffer.id);
    expect(driver.getInputBuffer().id).toBe(overview.inputBuffer.id);
  });
});

it("wiping the active shared input recreates and installs it without changing the archive view", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    driver.magenta.dispatch({
      type: "chat-msg",
      msg: { type: "archive-open" },
    });
    await driver.awaitChatState({ state: "archive" });

    const { displayWindow, inputWindow } = driver.getVisibleState();
    const archiveBefore = driver.magenta.bufferManager.getArchiveBuffers();
    await pollUntil(async () => {
      if (
        (await displayWindow.buffer()).id !== archiveBefore.displayBuffer.id
      ) {
        throw new Error("archive display not selected");
      }
    });

    const liveThreadId = driver.getThreadId(0);
    const liveInput =
      driver.magenta.bufferManager.getThreadBuffers(liveThreadId)!.inputBuffer;
    await driver.nvim.call("nvim_exec2", [
      `call win_execute(${inputWindow.id}, 'noautocmd buffer! ${liveInput.id}')`,
      {},
    ]);
    await driver.nvim.call("nvim_buf_delete", [
      archiveBefore.inputBuffer.id,
      { force: true },
    ]);

    await pollUntil(async () => {
      const archiveAfter = driver.magenta.bufferManager.getArchiveBuffers();
      if (archiveAfter.inputBuffer.id === archiveBefore.inputBuffer.id) {
        throw new Error("shared input not recreated");
      }
      if ((await inputWindow.buffer()).id !== archiveAfter.inputBuffer.id) {
        throw new Error("recreated shared input not installed");
      }
    });

    const archiveAfter = driver.magenta.bufferManager.getArchiveBuffers();
    await driver.awaitChatState({ state: "archive" });
    expect(archiveAfter.displayBuffer.id).toBe(archiveBefore.displayBuffer.id);
    expect((await displayWindow.buffer()).id).toBe(
      archiveBefore.displayBuffer.id,
    );
    expect((await inputWindow.buffer()).id).toBe(archiveAfter.inputBuffer.id);
  });
});

it("archived-thread displays are stable, distinct, listed buffers", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const firstId = uuidv7() as ThreadId;
    const secondId = uuidv7() as ThreadId;

    await driver.magenta.selectArchivedThread(firstId);
    const first =
      driver.magenta.bufferManager.getArchivedThreadBuffers(firstId)!;
    await driver.magenta.selectArchivedThread(secondId);
    const second =
      driver.magenta.bufferManager.getArchivedThreadBuffers(secondId)!;
    await driver.magenta.selectArchivedThread(firstId);
    const reopened =
      driver.magenta.bufferManager.getArchivedThreadBuffers(firstId)!;

    expect(first.displayBuffer.id).not.toBe(second.displayBuffer.id);
    expect(reopened.displayBuffer.id).toBe(first.displayBuffer.id);
    expect(first.inputBuffer.id).toBe(
      driver.magenta.bufferManager.getOverviewBuffers().inputBuffer.id,
    );
    expect(await first.displayBuffer.getOption("buflisted")).toBe(true);
    expect(await second.displayBuffer.getOption("buflisted")).toBe(true);
  });
});

it("wiping archive UI buffers preserves live threads and archive files", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const liveThreadId = driver.magenta.chat.getActiveThread().id;
    const archivedThreadId = uuidv7() as ThreadId;
    const logPath = threadConversationLogPath(archivedThreadId);
    await fs.mkdir(logPath.replace(/\/conversation\.jsonl$/, ""), {
      recursive: true,
    });
    await fs.writeFile(logPath, "archive data");

    await driver.magenta.selectArchivedThread(archivedThreadId);
    const detail =
      driver.magenta.bufferManager.getArchivedThreadBuffers(archivedThreadId)!;
    const archiveBeforeDetailWipe =
      driver.magenta.bufferManager.getArchiveBuffers();
    const { displayWindow, inputWindow } = driver.getVisibleState();
    await driver.nvim.call("nvim_exec2", [
      `call win_execute(${displayWindow.id}, 'noautocmd buffer! ${archiveBeforeDetailWipe.displayBuffer.id}')`,
      {},
    ]);
    await driver.nvim.call("nvim_buf_delete", [
      detail.displayBuffer.id,
      { force: true },
    ]);
    await pollUntil(() => {
      if (
        driver.magenta.bufferManager.getArchivedThreadBuffers(archivedThreadId)
      ) {
        throw new Error("archive detail still registered");
      }
    });
    await driver.awaitChatState({ state: "archive" });
    const activeArchive = driver.magenta.bufferManager.getArchiveBuffers();
    expect((await displayWindow.buffer()).id).toBe(
      activeArchive.displayBuffer.id,
    );
    expect((await inputWindow.buffer()).id).toBe(activeArchive.inputBuffer.id);

    expect(liveThreadId in driver.magenta.chat.threadWrappers).toBe(true);
    expect(await fs.readFile(logPath, "utf8")).toBe("archive data");

    const oldArchiveDisplay =
      driver.magenta.bufferManager.getArchiveBuffers().displayBuffer.id;
    const overview = driver.magenta.bufferManager.getOverviewBuffers();
    await driver.nvim.call("nvim_exec2", [
      `call win_execute(${displayWindow.id}, 'noautocmd buffer! ${overview.displayBuffer.id}')`,
      {},
    ]);
    await driver.nvim.call("nvim_buf_delete", [
      oldArchiveDisplay,
      { force: true },
    ]);
    await pollUntil(() => {
      if (
        driver.magenta.bufferManager.getArchiveBuffers().displayBuffer.id ===
        oldArchiveDisplay
      ) {
        throw new Error("archive list not recreated");
      }
    });
    const recreatedArchive = driver.magenta.bufferManager.getArchiveBuffers();
    await driver.awaitChatState({ state: "archive" });
    expect((await displayWindow.buffer()).id).toBe(
      recreatedArchive.displayBuffer.id,
    );
    expect((await inputWindow.buffer()).id).toBe(
      recreatedArchive.inputBuffer.id,
    );
    expect(liveThreadId in driver.magenta.chat.threadWrappers).toBe(true);
    expect(await fs.readFile(logPath, "utf8")).toBe("archive data");
  });
});

it.each([
  "generated",
  "manual",
  "destroyed",
  "failed",
  "invalid",
] as const)("automatic title: %s result is isolated from submission and lifecycle", async (outcome) => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const wrapper = driver.magenta.chat.getActiveThread();
    const thread = wrapper.thread;
    await driver.inputMagentaText("Explain this project");
    await driver.send();
    const titleRequest =
      await driver.mockAnthropic.awaitPendingForceToolUseRequest();
    expect(titleRequest.spec.name).toBe("thread_title");
    expect(titleRequest.model).toBe(wrapper.context.profile.fastModel);
    expect(titleRequest.systemPrompt).toBe(thread.systemPrompt);
    expect(titleRequest.input).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("Explain this project"),
      }),
    ]);
    const first = await driver.mockAnthropic.awaitPendingStream();
    first.respond({
      stopReason: "end_turn",
      text: "First answer",
      toolRequests: [],
    });
    await pollUntil(() => expect(thread.isBusy).toBe(false));
    await driver.inputMagentaText("Continue explaining");
    await driver.send();
    const second = await driver.mockAnthropic.awaitPendingStream();
    second.respond({
      stopReason: "end_turn",
      text: "Second answer",
      toolRequests: [],
    });
    await pollUntil(() => expect(thread.isBusy).toBe(false));
    expect(driver.mockAnthropic.forceToolUseRequests).toHaveLength(1);
    if (outcome === "manual") thread.setTitle("Manual title");
    if (outcome === "destroyed") await wrapper.destroy();
    if (outcome === "failed") {
      titleRequest.defer.reject(new Error("Title service unavailable"));
    } else if (outcome === "invalid") {
      await driver.mockAnthropic.respondToForceToolUse({
        stopReason: "tool_use",
        toolRequest: {
          status: "error",
          rawRequest: {},
          error: "Invalid title",
        },
      });
    } else {
      await driver.mockAnthropic.respondToForceToolUse({
        stopReason: "tool_use",
        toolRequest: {
          status: "ok",
          value: {
            id: "title" as ToolRequestId,
            toolName: "thread_title" as ToolName,
            input: { title: "Automatic title" },
          },
        },
      });
    }
    // Drain the promise continuation before inspecting absence of mutation.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const expectedTitle =
      outcome === "manual"
        ? "Manual title"
        : outcome === "generated"
          ? "Automatic title"
          : undefined;
    expect(thread.title).toBe(expectedTitle);
    expect(thread.lastResult()?.type).toBe("completed");
    await flushArchive(thread);
    const entries = (
      await fs.readFile(threadConversationLogPath(thread.id), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "title");
    expect(entries.map((entry) => entry.title)).toEqual(
      expectedTitle ? [expectedTitle] : [],
    );
  });
});
