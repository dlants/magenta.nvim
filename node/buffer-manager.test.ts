import * as fs from "node:fs/promises";
import type { ThreadId } from "@magenta/core";
import { threadConversationLogPath } from "@magenta/core";
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

    thread.core.setTitle("My Cool Title");

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
    await driver.command(`bwipeout! ${detail.displayBuffer.id}`);
    await pollUntil(() => {
      if (
        driver.magenta.bufferManager.getArchivedThreadBuffers(archivedThreadId)
      ) {
        throw new Error("archive detail still registered");
      }
    });

    expect(liveThreadId in driver.magenta.chat.threadWrappers).toBe(true);
    expect(await fs.readFile(logPath, "utf8")).toBe("archive data");

    const oldArchiveDisplay =
      driver.magenta.bufferManager.getArchiveBuffers().displayBuffer.id;
    await driver.command(`bwipeout! ${oldArchiveDisplay}`);
    await pollUntil(() => {
      if (
        driver.magenta.bufferManager.getArchiveBuffers().displayBuffer.id ===
        oldArchiveDisplay
      ) {
        throw new Error("archive list not recreated");
      }
    });
    expect(liveThreadId in driver.magenta.chat.threadWrappers).toBe(true);
    expect(await fs.readFile(logPath, "utf8")).toBe("archive data");
  });
});
