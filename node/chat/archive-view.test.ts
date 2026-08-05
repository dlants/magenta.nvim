import * as fs from "node:fs/promises";
import type { ThreadId } from "@magenta/core";
import { threadConversationLogPath, threadMetaPath } from "@magenta/core";
import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import { getAllWindows } from "../nvim/nvim.ts";
import type { Position1Indexed, Row0Indexed } from "../nvim/window.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

async function seedArchivedThread(id: ThreadId, title?: string): Promise<void> {
  const metaPath = threadMetaPath(id);
  await fs.mkdir(metaPath.replace(/\/meta\.json$/, ""), { recursive: true });
  await fs.writeFile(
    metaPath,
    JSON.stringify(
      title === undefined
        ? { threadType: "root" }
        : { title, threadType: "root" },
    ),
  );
  await fs.writeFile(threadConversationLogPath(id), "");
}

describe("node/chat/archive-view.test.ts", () => {
  it("live-thread [Archive] opens its managed archive detail", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const threadId = driver.getThreadId(0);
      const logPath = threadConversationLogPath(threadId);
      const resolvedLogPath = await fs.realpath(logPath);

      await driver.assertDisplayBufferContains("[Archive]");
      await driver.triggerDisplayBufferKeyOnContent("[Archive]", "<CR>");

      await driver.awaitChatState({
        state: "archive-thread-selected",
        id: threadId,
      });
      const detail = await pollUntil(() => {
        const buffers =
          driver.magenta.bufferManager.getArchivedThreadBuffers(threadId);
        if (!buffers) throw new Error("archive detail not registered yet");
        return buffers;
      });
      expect(driver.getDisplayBuffer().id).toBe(detail.displayBuffer.id);

      for (const window of await getAllWindows(driver.nvim)) {
        if (await window.getVar("magenta")) continue;
        expect(String(await (await window.buffer()).getName())).not.toBe(
          resolvedLogPath,
        );
      }
    });
  });

  it("archive detail path opens the raw log while Enter elsewhere stays native", async () => {
    await withDriver({}, async (driver) => {
      const id = uuidv7() as ThreadId;
      await seedArchivedThread(id, "Path mapping thread");
      const logPath = threadConversationLogPath(id);
      const resolvedLogPath = await fs.realpath(logPath);

      await driver.showSidebar();
      await driver.magenta.selectArchivedThread(id);
      await driver.assertDisplayBufferContains(logPath);

      const detail = driver.magenta.bufferManager.getArchivedThreadBuffers(id)!;
      const lines = await detail.displayBuffer.getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      expect(lines[1]).toBe(logPath);

      const { displayWindow } = driver.getVisibleState();
      await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
      await displayWindow.setCursor({ row: 2, col: 0 } as Position1Indexed);
      await driver.nvim.call("nvim_exec_lua", [
        `local mapping = vim.fn.maparg("<CR>", "n", false, true)
         mapping.callback()`,
        [],
      ]);

      await pollUntil(async () => {
        for (const window of await getAllWindows(driver.nvim)) {
          if (await window.getVar("magenta")) continue;
          if (
            String(await (await window.buffer()).getName()) === resolvedLogPath
          )
            return;
        }
        throw new Error("raw archive log not open yet");
      });

      expect(
        driver.magenta.bufferManager.getArchivedThreadBuffers(id)!.displayBuffer
          .id,
      ).toBe(detail.displayBuffer.id);
      expect(await detail.displayBuffer.isValid()).toBe(true);
      expect(driver.getDisplayBuffer().id).toBe(detail.displayBuffer.id);

      await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
      await displayWindow.setCursor({ row: 1, col: 0 } as Position1Indexed);
      await driver.nvim.call("nvim_exec_lua", [
        `local mapping = vim.fn.maparg("<CR>", "n", false, true)
         mapping.callback()`,
        [],
      ]);
      await pollUntil(async () => {
        const cursor = await displayWindow.getCursor();
        if (cursor.row !== 2) throw new Error("native Enter did not move down");
      });
    });
  });

  it("lists archived threads newest-first and hydrates titles", async () => {
    await withDriver({}, async (driver) => {
      const chat = driver.magenta.chat;

      const older = uuidv7() as ThreadId;
      await new Promise((r) => setTimeout(r, 5));
      const newer = uuidv7() as ThreadId;

      await seedArchivedThread(older, "Older thread");
      await seedArchivedThread(newer, "Newer thread");

      chat.update({ type: "chat-msg", msg: { type: "archive-open" } });

      await pollUntil(
        () => {
          if (chat.state.state !== "archive") throw new Error("not archive");
          const { threadIds, titles } = chat.state;
          if (!threadIds.includes(older) || !threadIds.includes(newer)) {
            throw new Error("ids not listed yet");
          }
          const olderTitle = titles[older];
          const newerTitle = titles[newer];
          if (
            olderTitle?.status !== "titled" ||
            olderTitle.title !== "Older thread" ||
            newerTitle?.status !== "titled" ||
            newerTitle.title !== "Newer thread"
          ) {
            throw new Error("titles not hydrated yet");
          }
        },
        { timeout: 3000 },
      );

      if (chat.state.state !== "archive") throw new Error("unreachable");
      // Newest id sorts after older, so it appears earlier in the list.
      expect(chat.state.threadIds.indexOf(newer)).toBeLessThan(
        chat.state.threadIds.indexOf(older),
      );

      // renderArchive should not throw for the hydrated state.
      expect(chat.renderArchive()).toBeTruthy();
    });
  });

  it("dd deletes a thread from the archive and disk", async () => {
    await withDriver({}, async (driver) => {
      const chat = driver.magenta.chat;
      const id = uuidv7() as ThreadId;
      await seedArchivedThread(id, "To delete");

      chat.update({ type: "chat-msg", msg: { type: "archive-open" } });
      await pollUntil(
        () => {
          if (chat.state.state !== "archive") throw new Error("not archive");
          if (!chat.state.threadIds.includes(id)) throw new Error("not listed");
        },
        { timeout: 3000 },
      );

      await driver.magenta.selectArchivedThread(id);
      const detail = driver.magenta.bufferManager.getArchivedThreadBuffers(id)!;
      await driver.magenta.command("threads-navigate-up");

      chat.update({
        type: "chat-msg",
        msg: { type: "archive-delete-thread", id },
      });

      if (chat.state.state !== "archive") throw new Error("unreachable");
      expect(chat.state.threadIds).not.toContain(id);
      await pollUntil(async () => {
        if (driver.magenta.bufferManager.getArchivedThreadBuffers(id)) {
          throw new Error("archive detail still registered");
        }
        if (await detail.displayBuffer.isValid()) {
          throw new Error("archive detail buffer still valid");
        }
      });

      await pollUntil(
        async () => {
          const exists = await fs
            .stat(threadConversationLogPath(id))
            .then(() => true)
            .catch(() => false);
          if (exists) throw new Error("still on disk");
        },
        { timeout: 3000 },
      );
    });
  });

  it("visual d deletes all selected threads from archive and disk", async () => {
    await withDriver({}, async (driver) => {
      const chat = driver.magenta.chat;

      const ids: ThreadId[] = [];
      for (let i = 0; i < 5; i++) {
        const id = uuidv7() as ThreadId;
        ids.push(id);
        await seedArchivedThread(id, `Thread ${i}`);
        await new Promise((r) => setTimeout(r, 2));
      }

      await driver.showSidebar();
      await driver.magenta.command("threads-overview");
      await driver.awaitChatState({ state: "thread-overview" });
      await driver.triggerDisplayBufferKeyOnContent("[archive]", "<CR>");
      await pollUntil(
        () => {
          if (chat.state.state !== "archive") throw new Error("not archive");
          for (const id of ids) {
            if (!chat.state.threadIds.includes(id)) {
              throw new Error("ids not listed yet");
            }
            if (chat.state.titles[id] === undefined) {
              throw new Error("titles not hydrated yet");
            }
          }
        },
        { timeout: 3000 },
      );

      if (chat.state.state !== "archive") throw new Error("unreachable");
      // Rows are newest-first; anchor on the 2nd row and select 3 rows.
      const ordered = chat.state.threadIds;
      const anchorTitle = chat.state.titles[ordered[1]];
      if (anchorTitle?.status !== "titled") throw new Error("no title");
      const expectedDeleted = ordered.slice(1, 4);
      const unselectedId = ordered[0];
      const registeredDetails = new Map<
        ThreadId,
        NonNullable<
          ReturnType<
            typeof driver.magenta.bufferManager.getArchivedThreadBuffers
          >
        >
      >();
      for (const id of [...expectedDeleted, unselectedId]) {
        await driver.magenta.selectArchivedThread(id);
        registeredDetails.set(
          id,
          driver.magenta.bufferManager.getArchivedThreadBuffers(id)!,
        );
        await driver.magenta.command("threads-navigate-up");
      }

      // Visual selection over 3 rows, anchored at the 2nd row.
      await driver.pressOnDisplayMessageWithSelection(anchorTitle.title, "d", [
        "line1",
        "line2",
        "line3",
      ]);

      await pollUntil(
        () => {
          if (chat.state.state !== "archive") throw new Error("not archive");
          for (const id of expectedDeleted) {
            if (chat.state.threadIds.includes(id)) {
              throw new Error("still listed");
            }
          }
        },
        { timeout: 3000 },
      );

      if (chat.state.state !== "archive") throw new Error("unreachable");
      // Remaining threads still present.
      expect(chat.state.threadIds).toContain(ordered[0]);
      expect(chat.state.threadIds).toContain(ordered[4]);

      for (const id of expectedDeleted) {
        const detail = registeredDetails.get(id)!;
        expect(
          driver.magenta.bufferManager.getArchivedThreadBuffers(id),
        ).toBeUndefined();
        expect(await detail.displayBuffer.isValid()).toBe(false);
      }
      const unselectedDetail = registeredDetails.get(unselectedId)!;
      const retainedUnselected =
        driver.magenta.bufferManager.getArchivedThreadBuffers(unselectedId);
      expect(retainedUnselected).toBeDefined();
      expect(retainedUnselected!.displayBuffer.id).toBe(
        unselectedDetail.displayBuffer.id,
      );
      expect(await unselectedDetail.displayBuffer.isValid()).toBe(true);

      for (const id of expectedDeleted) {
        await pollUntil(
          async () => {
            const exists = await fs
              .stat(threadConversationLogPath(id))
              .then(() => true)
              .catch(() => false);
            if (exists) throw new Error("still on disk");
          },
          { timeout: 3000 },
        );
      }
    });
  });

  it("<CR> opens a managed read-only archive detail and refreshes it on re-entry", async () => {
    await withDriver({}, async (driver) => {
      const id = uuidv7() as ThreadId;
      await seedArchivedThread(id, "Rendered thread");
      const logPath = threadConversationLogPath(id);
      const initialLog = [
        JSON.stringify({
          type: "thread_start",
          timestamp: "t0",
          threadType: "root",
        }),
        JSON.stringify({
          type: "message",
          timestamp: "t1",
          message: {
            role: "user",
            content: [{ type: "text", text: "HELLO_FROM_ARCHIVE" }],
          },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "t2",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "INITIAL_ASSISTANT_REPLY" }],
          },
        }),
      ];
      await fs.writeFile(logPath, `${initialLog.join("\n")}\n`);

      const chat = driver.magenta.chat;
      await driver.showSidebar();
      await driver.magenta.command("threads-overview");
      await driver.triggerDisplayBufferKeyOnContent("[archive]", "<CR>");
      await pollUntil(() => {
        if (chat.state.state !== "archive") throw new Error("not archive");
        if (!chat.state.threadIds.includes(id)) throw new Error("not listed");
      });

      await driver.triggerDisplayBufferKeyOnContent("Rendered thread", "<CR>");
      await driver.awaitChatState({ state: "archive-thread-selected", id });
      await driver.assertDisplayBufferContains("# Archived thread");
      await driver.assertDisplayBufferContains("HELLO_FROM_ARCHIVE");
      await driver.assertDisplayBufferContains("INITIAL_ASSISTANT_REPLY");

      const detail = driver.magenta.bufferManager.getArchivedThreadBuffers(id)!;
      expect(driver.getDisplayBuffer().id).toBe(detail.displayBuffer.id);
      expect(await detail.displayBuffer.getOption("filetype")).toBe("markdown");
      expect(await detail.displayBuffer.getOption("modifiable")).toBe(false);

      await driver.magenta.command("threads-navigate-up");
      await fs.appendFile(
        logPath,
        `${JSON.stringify({
          type: "message",
          timestamp: "t3",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "REFRESHED_REPLY" }],
          },
        })}\n`,
      );

      await driver.magenta.selectArchivedThread(id);
      await driver.assertDisplayBufferContains("REFRESHED_REPLY");
      expect(await detail.displayBuffer.getOption("modifiable")).toBe(false);

      await driver.magenta.command("threads-navigate-up");
      await fs.appendFile(
        logPath,
        `${JSON.stringify({
          type: "message",
          timestamp: "t4",
          message: {
            role: "user",
            content: [{ type: "text", text: "BUF_ENTER_REFRESH" }],
          },
        })}\n`,
      );
      const { displayWindow } = driver.getVisibleState();
      await displayWindow.setBufferForced(detail.displayBuffer);
      await driver.awaitChatState({ state: "archive-thread-selected", id });
      await driver.assertDisplayBufferContains("BUF_ENTER_REFRESH");
      expect(await detail.displayBuffer.getOption("modifiable")).toBe(false);
    });
  });

  it("<CR> on a corrupt log opens a usable archive detail", async () => {
    await withDriver({}, async (driver) => {
      const id = uuidv7() as ThreadId;
      const metaPath = threadMetaPath(id);
      await fs.mkdir(metaPath.replace(/\/meta\.json$/, ""), {
        recursive: true,
      });
      await fs.writeFile(
        metaPath,
        JSON.stringify({ title: "Corrupt thread", threadType: "root" }),
      );
      await fs.writeFile(
        threadConversationLogPath(id),
        "this is not valid json\n{also bad",
      );

      const chat = driver.magenta.chat;
      await driver.showSidebar();
      await driver.magenta.command("threads-overview");
      await driver.awaitChatState({ state: "thread-overview" });
      await driver.triggerDisplayBufferKeyOnContent("[archive]", "<CR>");
      await pollUntil(
        () => {
          if (chat.state.state !== "archive") throw new Error("not archive");
          if (!chat.state.threadIds.includes(id)) throw new Error("not listed");
        },
        { timeout: 3000 },
      );
      await driver.assertDisplayBufferContains("Corrupt thread");

      await driver.triggerDisplayBufferKeyOnContent("Corrupt thread", "<CR>");

      await driver.awaitChatState({ state: "archive-thread-selected", id });
      await driver.assertDisplayBufferContains("# Archived thread");
      let detail = driver.magenta.bufferManager.getArchivedThreadBuffers(id);
      await pollUntil(() => {
        detail = driver.magenta.bufferManager.getArchivedThreadBuffers(id);
        if (!detail) throw new Error("archive detail not registered");
      });
      expect(await detail!.displayBuffer.getOption("modifiable")).toBe(false);
    });
  });

  it("missing and empty logs produce usable archive details", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const emptyId = uuidv7() as ThreadId;
      await seedArchivedThread(emptyId, "Empty archive");
      const missingId = uuidv7() as ThreadId;

      for (const id of [emptyId, missingId]) {
        await driver.magenta.selectArchivedThread(id);
        await driver.assertDisplayBufferContains("# Archived thread");
        const detail =
          driver.magenta.bufferManager.getArchivedThreadBuffers(id)!;
        expect(await detail.displayBuffer.getOption("modifiable")).toBe(false);
        expect(driver.getDisplayBuffer().id).toBe(detail.displayBuffer.id);
      }
    });
  });

  it("hydrates untitled threads as untitled", async () => {
    await withDriver({}, async (driver) => {
      const chat = driver.magenta.chat;
      const id = uuidv7() as ThreadId;
      await seedArchivedThread(id);

      chat.update({ type: "chat-msg", msg: { type: "archive-open" } });
      await pollUntil(
        () => {
          if (chat.state.state !== "archive") throw new Error("not archive");
          if (chat.state.titles[id] === undefined) {
            throw new Error("not hydrated yet");
          }
        },
        { timeout: 3000 },
      );

      if (chat.state.state !== "archive") throw new Error("unreachable");
      expect(chat.state.titles[id]).toEqual({ status: "untitled" });
    });
  });

  it("lazily hydrates a page at a time and load-more reveals the next page", async () => {
    await withDriver({}, async (driver) => {
      const chat = driver.magenta.chat;

      const ids: ThreadId[] = [];
      for (let i = 0; i < 55; i++) {
        const id = uuidv7() as ThreadId;
        ids.push(id);
        await seedArchivedThread(id, `Thread ${i}`);
      }
      // Newest-first order.
      const sorted = [...ids].sort().reverse();

      chat.update({ type: "chat-msg", msg: { type: "archive-open" } });

      await pollUntil(
        () => {
          if (chat.state.state !== "archive") throw new Error("not archive");
          for (const id of ids) {
            if (!chat.state.threadIds.includes(id)) {
              throw new Error("ids not listed yet");
            }
          }
          // First 50 should hydrate.
          for (const id of sorted.slice(0, 50)) {
            if (chat.state.titles[id] === undefined) {
              throw new Error("first page not hydrated yet");
            }
          }
        },
        { timeout: 5000 },
      );

      if (chat.state.state !== "archive") throw new Error("unreachable");
      // Rows beyond the first page must NOT be hydrated yet.
      for (const id of sorted.slice(50)) {
        expect(chat.state.titles[id]).toBeUndefined();
      }

      chat.update({ type: "chat-msg", msg: { type: "archive-load-more" } });

      await pollUntil(
        () => {
          if (chat.state.state !== "archive") throw new Error("not archive");
          for (const id of sorted.slice(50)) {
            if (chat.state.titles[id] === undefined) {
              throw new Error("second page not hydrated yet");
            }
          }
        },
        { timeout: 10000 },
      );
    });
  }, 30000);

  it("archive link in the overview opens the archive view and back returns", async () => {
    await withDriver({}, async (driver) => {
      const id = uuidv7() as ThreadId;
      await seedArchivedThread(id, "Archived one");

      await driver.showSidebar();
      await driver.magenta.command("threads-overview");
      await driver.awaitChatState({ state: "thread-overview" });
      await driver.assertDisplayBufferContains("[archive]");

      await driver.triggerDisplayBufferKeyOnContent("[archive]", "<CR>");
      await pollUntil(
        () => {
          if (driver.magenta.chat.state.state !== "archive") {
            throw new Error("not archive yet");
          }
        },
        { timeout: 3000 },
      );
      await driver.assertDisplayBufferContains("# Archived threads");

      await driver.triggerDisplayBufferKeyOnContent(
        "< back to threads",
        "<CR>",
      );
      await driver.awaitChatState({ state: "thread-overview" });
      await driver.assertDisplayBufferContains("# Threads");
    });
  });

  it("navigate-back returns to the thread overview", async () => {
    await withDriver({}, async (driver) => {
      const chat = driver.magenta.chat;
      chat.update({ type: "chat-msg", msg: { type: "archive-open" } });
      await pollUntil(
        () => {
          if (chat.state.state !== "archive") throw new Error("not archive");
        },
        { timeout: 3000 },
      );

      chat.update({
        type: "chat-msg",
        msg: { type: "archive-navigate-back" },
      });
      expect(chat.state.state).toBe("thread-overview");
    });
  });
});
