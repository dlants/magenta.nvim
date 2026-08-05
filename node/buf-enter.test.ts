import type { ThreadId } from "@magenta/core";
import { describe, expect, it } from "vitest";
import type { BufNr, Line } from "./nvim/buffer.ts";
import type { Row0Indexed, WindowId } from "./nvim/window.ts";
import { withDriver } from "./test/preamble.ts";
import { pollUntil } from "./utils/async.ts";

describe("node/buf-enter.test.ts", () => {
  describe("non-magenta buffer in magenta window", () => {
    it("should eject a non-magenta buffer from the display window and restore the magenta buffer", async () => {
      await withDriver({}, async (driver) => {
        // Open a file first so we have a non-magenta window, then show sidebar
        await driver.editFile("poem.txt");
        const poemBufId = (await driver.nvim.call(
          "nvim_get_current_buf",
          [],
        )) as BufNr;

        await driver.showSidebar();
        const { displayWindow, inputWindow } = driver.getVisibleState();
        const expectedDisplayBufId = driver.getDisplayBuffer().id;

        // Switch to the display window, then open the poem buffer there.
        // This triggers BufEnter for a non-magenta buffer in a magenta window.
        await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
        await driver.forceWinSetBuf(displayWindow.id, poemBufId);

        // Wait for the handler to restore the magenta buffer in the display window
        await pollUntil(async () => {
          const currentBufId = (await driver.nvim.call("nvim_win_get_buf", [
            displayWindow.id,
          ])) as BufNr;
          if (currentBufId !== expectedDisplayBufId) {
            throw new Error(
              `Display window still has buffer ${currentBufId}, expected ${expectedDisplayBufId}`,
            );
          }
        });

        // Verify the poem.txt was moved to a non-magenta window
        const windows = (await driver.nvim.call(
          "nvim_list_wins",
          [],
        )) as WindowId[];
        let poemFoundInNonMagentaWindow = false;
        for (const winId of windows) {
          if (winId === displayWindow.id || winId === inputWindow.id) continue;
          const bufId = (await driver.nvim.call("nvim_win_get_buf", [
            winId,
          ])) as BufNr;
          if (bufId === poemBufId) {
            poemFoundInNonMagentaWindow = true;
            break;
          }
        }
        expect(poemFoundInNonMagentaWindow).toBe(true);
      });
    });

    it("should eject a non-magenta buffer from the input window", async () => {
      await withDriver({}, async (driver) => {
        await driver.editFile("poem.txt");
        const poemBufId = (await driver.nvim.call(
          "nvim_get_current_buf",
          [],
        )) as BufNr;

        await driver.showSidebar();
        const { inputWindow } = driver.getVisibleState();
        const expectedInputBufId = driver.getInputBuffer().id;

        // Switch to the input window, then open poem there
        await driver.nvim.call("nvim_set_current_win", [inputWindow.id]);
        await driver.forceWinSetBuf(inputWindow.id, poemBufId);

        // Wait for the handler to restore the magenta input buffer
        await pollUntil(async () => {
          const currentBufId = (await driver.nvim.call("nvim_win_get_buf", [
            inputWindow.id,
          ])) as BufNr;
          if (currentBufId !== expectedInputBufId) {
            throw new Error(
              `Input window still has buffer ${currentBufId}, expected ${expectedInputBufId}`,
            );
          }
        });
      });
    });
  });

  it("should create a new window when ejecting a buffer with only magenta windows visible", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const { displayWindow, inputWindow } = driver.getVisibleState();
      const expectedDisplayBufId = driver.getDisplayBuffer().id;

      // Close all non-magenta windows so only magenta windows remain
      const allWindows = (await driver.nvim.call(
        "nvim_list_wins",
        [],
      )) as WindowId[];
      for (const winId of allWindows) {
        if (winId === displayWindow.id || winId === inputWindow.id) continue;
        await driver.nvim.call("nvim_win_close", [winId, true]);
      }
      await driver.assertWindowCount(2);

      // Force a file into the display window (bypassing 'winfixbuf'), simulating
      // a `:edit!`-style forced open — the only place nvim can put it.
      await driver.nvim.call("nvim_exec2", ["badd poem.txt", {}]);
      const poemBufId = (await driver.nvim.call("nvim_exec2", [
        `echo bufnr('poem.txt')`,
        { output: true },
      ])) as { output: string };
      await driver.forceWinSetBuf(
        displayWindow.id,
        Number(poemBufId.output) as BufNr,
      );

      // Wait for the handler to restore the magenta buffer in the display window
      await pollUntil(async () => {
        const currentBufId = (await driver.nvim.call("nvim_win_get_buf", [
          displayWindow.id,
        ])) as BufNr;
        if (currentBufId !== expectedDisplayBufId) {
          throw new Error(
            `Display window has buffer ${currentBufId}, expected magenta buffer ${expectedDisplayBufId}`,
          );
        }
      });

      // A new non-magenta window should have been created with poem.txt
      await driver.assertWindowCount(
        3,
        "Expected a new non-magenta window to be created for poem.txt",
      );
      const windowsAfter = (await driver.nvim.call(
        "nvim_list_wins",
        [],
      )) as WindowId[];

      // Find the new window and verify it has poem.txt
      let poemWindowFound = false;
      for (const winId of windowsAfter) {
        if (winId === displayWindow.id || winId === inputWindow.id) continue;
        const bufId = await driver.nvim.call("nvim_win_get_buf", [winId]);
        const bufName = (await driver.nvim.call("nvim_buf_get_name", [
          bufId,
        ])) as string;
        if (bufName.includes("poem.txt")) {
          poemWindowFound = true;
        }
      }
      expect(poemWindowFound).toBe(true);
    });
  });

  describe("magenta buffer navigation within magenta windows", () => {
    it("should sync input buffer when ctrl-o navigates to a different thread's display buffer", async () => {
      await withDriver({}, async (driver) => {
        await driver.editFile("poem.txt");
        await driver.showSidebar();
        const { displayWindow, inputWindow } = driver.getVisibleState();

        const thread1Id = driver.getThreadId(0);
        await driver.magenta.command("new-thread");
        await driver.awaitThreadCount(2);
        const thread2Id = driver.getThreadId(1);

        await driver.awaitChatState({
          state: "thread-selected",
          id: thread2Id,
        });

        // Get thread 1's buffers
        const thread1Buffers =
          driver.magenta.bufferManager.getThreadBuffers(thread1Id);
        expect(thread1Buffers).toBeDefined();
        const thread1DisplayBufId = thread1Buffers!.displayBuffer.id;
        const thread1InputBufId = thread1Buffers!.inputBuffer.id;

        // Simulate ctrl-o navigating the display window to thread 1's display buffer
        await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
        await driver.forceWinSetBuf(displayWindow.id, thread1DisplayBufId);

        // Wait for state to switch to thread 1
        await driver.awaitChatState({
          state: "thread-selected",
          id: thread1Id,
        });

        // Input window should now show thread 1's input buffer
        await pollUntil(async () => {
          const inputBufId = (await driver.nvim.call("nvim_win_get_buf", [
            inputWindow.id,
          ])) as BufNr;
          if (inputBufId !== thread1InputBufId) {
            throw new Error(
              `Input window has buffer ${inputBufId}, expected thread 1's input buffer ${thread1InputBufId}`,
            );
          }
        });

        // Display window should have thread 1's display buffer
        const displayBufId = (await driver.nvim.call("nvim_win_get_buf", [
          displayWindow.id,
        ])) as BufNr;
        expect(displayBufId).toBe(thread1DisplayBufId);
      });
    });

    it("should sync display buffer when an input buffer appears in the input window for a different thread", async () => {
      await withDriver({}, async (driver) => {
        await driver.editFile("poem.txt");
        await driver.showSidebar();
        const { displayWindow, inputWindow } = driver.getVisibleState();

        const thread1Id = driver.getThreadId(0);
        await driver.magenta.command("new-thread");
        await driver.awaitThreadCount(2);
        const thread2Id = driver.getThreadId(1);

        await driver.awaitChatState({
          state: "thread-selected",
          id: thread2Id,
        });

        // Get thread 1's buffers
        const thread1Buffers =
          driver.magenta.bufferManager.getThreadBuffers(thread1Id);
        expect(thread1Buffers).toBeDefined();
        const thread1DisplayBufId = thread1Buffers!.displayBuffer.id;
        const thread1InputBufId = thread1Buffers!.inputBuffer.id;

        // Navigate the input window to thread 1's input buffer
        await driver.nvim.call("nvim_set_current_win", [inputWindow.id]);
        await driver.forceWinSetBuf(inputWindow.id, thread1InputBufId);

        // Wait for state to switch to thread 1
        await driver.awaitChatState({
          state: "thread-selected",
          id: thread1Id,
        });

        // Display window should now show thread 1's display buffer
        await pollUntil(async () => {
          const displayBufId = (await driver.nvim.call("nvim_win_get_buf", [
            displayWindow.id,
          ])) as BufNr;
          if (displayBufId !== thread1DisplayBufId) {
            throw new Error(
              `Display window has buffer ${displayBufId}, expected thread 1's display buffer ${thread1DisplayBufId}`,
            );
          }
        });
      });
    });
  });

  it("should coerce an input buffer opened in the display window to the correct windows", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("poem.txt");
      await driver.showSidebar();
      const { displayWindow, inputWindow } = driver.getVisibleState();

      const threadId = driver.getThreadId(0);
      const threadBuffers =
        driver.magenta.bufferManager.getThreadBuffers(threadId);
      expect(threadBuffers).toBeDefined();
      const expectedDisplayBufId = threadBuffers!.displayBuffer.id;
      const expectedInputBufId = threadBuffers!.inputBuffer.id;

      // Open the input buffer in the display window (wrong role)
      await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
      await driver.forceWinSetBuf(displayWindow.id, expectedInputBufId);

      // Display window should be restored to the display buffer
      await pollUntil(async () => {
        const displayBufId = (await driver.nvim.call("nvim_win_get_buf", [
          displayWindow.id,
        ])) as BufNr;
        if (displayBufId !== expectedDisplayBufId) {
          throw new Error(
            `Display window has buffer ${displayBufId}, expected display buffer ${expectedDisplayBufId}`,
          );
        }
      });

      // Input window should still have the input buffer
      const inputBufId = (await driver.nvim.call("nvim_win_get_buf", [
        inputWindow.id,
      ])) as BufNr;
      expect(inputBufId).toBe(expectedInputBufId);
    });
  });

  it("should coerce a different thread's input buffer opened in the display window", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("poem.txt");
      await driver.showSidebar();
      const { displayWindow, inputWindow } = driver.getVisibleState();

      const thread1Id = driver.getThreadId(0);
      await driver.magenta.command("new-thread");
      await driver.awaitThreadCount(2);
      const thread2Id = driver.getThreadId(1);

      await driver.awaitChatState({
        state: "thread-selected",
        id: thread2Id,
      });

      // Get thread 1's buffers
      const thread1Buffers =
        driver.magenta.bufferManager.getThreadBuffers(thread1Id);
      expect(thread1Buffers).toBeDefined();
      const thread1DisplayBufId = thread1Buffers!.displayBuffer.id;
      const thread1InputBufId = thread1Buffers!.inputBuffer.id;

      // Open thread 1's INPUT buffer in the DISPLAY window (wrong thread + wrong role)
      await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
      await driver.forceWinSetBuf(displayWindow.id, thread1InputBufId);

      // Should switch to thread 1
      await driver.awaitChatState({
        state: "thread-selected",
        id: thread1Id,
      });

      // Display window should show thread 1's display buffer (not the input buffer)
      await pollUntil(async () => {
        const displayBufId = (await driver.nvim.call("nvim_win_get_buf", [
          displayWindow.id,
        ])) as BufNr;
        if (displayBufId !== thread1DisplayBufId) {
          throw new Error(
            `Display window has buffer ${displayBufId}, expected thread 1's display buffer ${thread1DisplayBufId}`,
          );
        }
      });

      // Input window should show thread 1's input buffer
      const inputBufId = (await driver.nvim.call("nvim_win_get_buf", [
        inputWindow.id,
      ])) as BufNr;
      expect(inputBufId).toBe(thread1InputBufId);
    });
  });

  it("should coerce a display buffer opened in the input window to the correct windows", async () => {
    await withDriver({}, async (driver) => {
      await driver.editFile("poem.txt");
      await driver.showSidebar();
      const { displayWindow, inputWindow } = driver.getVisibleState();

      const threadId = driver.getThreadId(0);
      const threadBuffers =
        driver.magenta.bufferManager.getThreadBuffers(threadId);
      expect(threadBuffers).toBeDefined();
      const expectedDisplayBufId = threadBuffers!.displayBuffer.id;
      const expectedInputBufId = threadBuffers!.inputBuffer.id;

      // Open the display buffer in the input window (wrong role)
      await driver.nvim.call("nvim_set_current_win", [inputWindow.id]);
      await driver.forceWinSetBuf(inputWindow.id, expectedDisplayBufId);

      // Input window should be restored to the input buffer
      await pollUntil(async () => {
        const inputBufId = (await driver.nvim.call("nvim_win_get_buf", [
          inputWindow.id,
        ])) as BufNr;
        if (inputBufId !== expectedInputBufId) {
          throw new Error(
            `Input window has buffer ${inputBufId}, expected input buffer ${expectedInputBufId}`,
          );
        }
      });

      // Display window should still have the display buffer
      const displayBufId = (await driver.nvim.call("nvim_win_get_buf", [
        displayWindow.id,
      ])) as BufNr;
      expect(displayBufId).toBe(expectedDisplayBufId);
    });
  });

  it("syncs archive detail state and shared input when jump navigation enters its buffer", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const { displayWindow, inputWindow } = driver.getVisibleState();
      const firstId = `${driver.getThreadId(0)}-archive-1` as ThreadId;
      const secondId = `${driver.getThreadId(0)}-archive-2` as ThreadId;

      await driver.magenta.selectArchivedThread(firstId);
      const first =
        driver.magenta.bufferManager.getArchivedThreadBuffers(firstId)!;
      await driver.magenta.selectArchivedThread(secondId);

      await displayWindow.setBufferForced(first.displayBuffer);
      await driver.awaitChatState({
        state: "archive-thread-selected",
        id: firstId,
      });
      expect((await displayWindow.buffer()).id).toBe(first.displayBuffer.id);
      expect((await inputWindow.buffer()).id).toBe(first.inputBuffer.id);
    });
  });

  it("syncs archive-list state and shared input when jump navigation enters its buffer", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const { displayWindow, inputWindow } = driver.getVisibleState();
      const archivedThreadId = `${driver.getThreadId(0)}-archive` as ThreadId;
      const archive = driver.magenta.bufferManager.getArchiveBuffers();

      await driver.magenta.selectArchivedThread(archivedThreadId);
      await displayWindow.setBufferForced(archive.displayBuffer);
      await driver.awaitChatState({ state: "archive" });

      expect((await displayWindow.buffer()).id).toBe(archive.displayBuffer.id);
      expect((await inputWindow.buffer()).id).toBe(archive.inputBuffer.id);
    });
  });

  it("actual ctrl-o and ctrl-i jumps restore every registered view", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const { displayWindow, inputWindow } = driver.getVisibleState();
      const liveThreadId = driver.getThreadId(0);
      const live = driver.magenta.bufferManager.getThreadBuffers(liveThreadId)!;
      const archivedThreadId = `${liveThreadId}-jump-archive` as ThreadId;

      await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
      await driver.nvim.call("nvim_exec2", ["normal! ggG", {}]);

      await driver.magenta.command("threads-overview");
      const overview = driver.magenta.bufferManager.getOverviewBuffers();
      await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
      await driver.nvim.call("nvim_exec2", ["normal! ggG", {}]);

      driver.magenta.dispatch({
        type: "chat-msg",
        msg: { type: "archive-open" },
      });
      await driver.awaitChatState({ state: "archive" });
      const archive = driver.magenta.bufferManager.getArchiveBuffers();
      await pollUntil(async () => {
        if ((await displayWindow.buffer()).id !== archive.displayBuffer.id) {
          throw new Error("archive display not ready");
        }
      });
      await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
      await driver.nvim.call("nvim_exec2", ["normal! ggG", {}]);

      await driver.magenta.selectArchivedThread(archivedThreadId);
      const detail =
        driver.magenta.bufferManager.getArchivedThreadBuffers(
          archivedThreadId,
        )!;
      await detail.displayBuffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["one", "two", "three"] as Line[],
      });
      await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
      await driver.nvim.call("nvim_exec2", ["normal! ggG", {}]);

      const waitForBufEnter = () =>
        pollUntil(() => {
          const magenta = driver.magenta as unknown as {
            handlingBufEnter: boolean;
          };
          if (magenta.handlingBufEnter) {
            throw new Error("BufEnter synchronization still running");
          }
        });

      const jumpToBuffer = async (key: "<C-o>" | "<C-i>", target: BufNr) => {
        for (let attempt = 0; attempt < 10; attempt++) {
          if (key === "<C-i>") {
            await driver.nvim.call("nvim_exec_lua", [
              `local mapping = vim.fn.maparg("<C-i>", "n", false, true)
               mapping.callback()`,
              [],
            ]);
          } else {
            await driver.nvim.call("nvim_exec_lua", [
              `local encoded = vim.api.nvim_replace_termcodes(..., true, false, true)
               vim.api.nvim_feedkeys(encoded, "mx", false)`,
              [key],
            ]);
          }
          if ((await displayWindow.buffer()).id === target) return;
        }
        const jumplist = await driver.nvim.call("nvim_exec_lua", [
          "return vim.fn.getjumplist(vim.fn.win_getid())",
          [],
        ]);
        throw new Error(
          `jump ${key} did not reach buffer ${target}: ${JSON.stringify(jumplist)}`,
        );
      };

      await jumpToBuffer("<C-o>", archive.displayBuffer.id);

      await driver.awaitChatState({ state: "archive" });
      await waitForBufEnter();
      await pollUntil(async () => {
        if ((await inputWindow.buffer()).id !== archive.inputBuffer.id) {
          throw new Error("archive input not synchronized");
        }
      });

      await jumpToBuffer("<C-o>", overview.displayBuffer.id);

      await driver.awaitChatState({ state: "thread-overview" });
      await waitForBufEnter();
      expect((await displayWindow.buffer()).id).toBe(overview.displayBuffer.id);

      await jumpToBuffer("<C-o>", live.displayBuffer.id);

      await driver.awaitChatState({
        state: "thread-selected",
        id: liveThreadId,
      });
      await waitForBufEnter();
      expect((await displayWindow.buffer()).id).toBe(live.displayBuffer.id);
      expect((await inputWindow.buffer()).id).toBe(live.inputBuffer.id);

      await jumpToBuffer("<C-i>", overview.displayBuffer.id);

      await driver.awaitChatState({ state: "thread-overview" });
      await waitForBufEnter();
      await jumpToBuffer("<C-i>", archive.displayBuffer.id);

      await driver.awaitChatState({ state: "archive" });
      await waitForBufEnter();
      await jumpToBuffer("<C-i>", detail.displayBuffer.id);

      await driver.awaitChatState({
        state: "archive-thread-selected",
        id: archivedThreadId,
      });
      await waitForBufEnter();
      expect((await displayWindow.buffer()).id).toBe(detail.displayBuffer.id);
      expect((await inputWindow.buffer()).id).toBe(detail.inputBuffer.id);
    });
  }, 15000);

  it("the display '-' mapping navigates archive detail to archive list to overview", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const { displayWindow } = driver.getVisibleState();
      const liveThreadId = driver.getThreadId(0);
      const archivedThreadId = `${liveThreadId}-archived` as ThreadId;

      await driver.magenta.selectArchivedThread(archivedThreadId);
      await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
      await driver.nvim.call("nvim_exec2", ["normal -", {}]);
      await driver.awaitChatState({ state: "archive" });
      expect(driver.getDisplayBuffer().id).toBe(
        driver.magenta.bufferManager.getArchiveBuffers().displayBuffer.id,
      );

      await driver.nvim.call("nvim_exec2", ["normal -", {}]);
      await driver.awaitChatState({ state: "thread-overview" });
      expect(driver.getDisplayBuffer().id).toBe(
        driver.magenta.bufferManager.getOverviewBuffers().displayBuffer.id,
      );

      await driver.magenta.selectThreadEffect(liveThreadId);
      await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
      await driver.nvim.call("nvim_exec2", ["normal -", {}]);
      await driver.awaitChatState({ state: "thread-overview" });
    });
  });

  describe("magenta buffer in non-magenta window", () => {
    it("should switch sidebar to the correct thread when a magenta display buffer is opened in a code window", async () => {
      await withDriver({}, async (driver) => {
        // Open a file first so there's a non-magenta window
        await driver.editFile("poem.txt");
        const codeWinId = (await driver.nvim.call(
          "nvim_get_current_win",
          [],
        )) as WindowId;

        await driver.showSidebar();
        const { displayWindow } = driver.getVisibleState();

        const thread1Id = driver.getThreadId(0);
        await driver.magenta.command("new-thread");
        await driver.awaitThreadCount(2);
        const thread2Id = driver.getThreadId(1);

        await driver.awaitChatState({
          state: "thread-selected",
          id: thread2Id,
        });

        // Get thread 1's display buffer
        const thread1Buffers =
          driver.magenta.bufferManager.getThreadBuffers(thread1Id);
        expect(thread1Buffers).toBeDefined();
        const thread1DisplayBufId = thread1Buffers!.displayBuffer.id;

        // Switch to the code window, then open thread 1's display buffer there
        await driver.nvim.call("nvim_set_current_win", [codeWinId]);

        // Open thread 1's display buffer in the code window (current window).
        // This triggers BufEnter for a magenta buffer in a non-magenta window.
        await driver.nvim.call("nvim_win_set_buf", [
          codeWinId,
          thread1DisplayBufId,
        ]);

        // Wait for the sidebar to switch to thread 1
        await driver.awaitChatState({
          state: "thread-selected",
          id: thread1Id,
        });

        // The code window should no longer have the magenta buffer
        await pollUntil(async () => {
          const codeBufId = (await driver.nvim.call("nvim_win_get_buf", [
            codeWinId,
          ])) as BufNr;
          if (codeBufId === thread1DisplayBufId) {
            throw new Error("Code window still has the magenta buffer");
          }
        });

        // The display window should now show thread 1's buffer
        await pollUntil(async () => {
          const displayBufId = (await driver.nvim.call("nvim_win_get_buf", [
            displayWindow.id,
          ])) as BufNr;
          if (displayBufId !== thread1DisplayBufId) {
            throw new Error(
              `Display window has buffer ${displayBufId}, expected thread 1's buffer ${thread1DisplayBufId}`,
            );
          }
        });
      });
    });
  });
});
