import type { ThreadId, ToolName, ToolRequestId } from "@magenta/core";
import { describe, expect, it } from "vitest";
import {
  type BufNr,
  MAGENTA_COMMENT_NAMESPACE,
  NvimBuffer,
} from "../nvim/buffer.ts";
import type { WindowId } from "../nvim/window.ts";
import type { NvimDriver } from "../test/driver.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

/** Open poem.txt in a non-magenta window and return its bufnr + winid. */
async function openPoem(driver: NvimDriver) {
  await driver.editFile("poem.txt");
  const bufnr = (await driver.nvim.call("nvim_get_current_buf", [])) as BufNr;
  const winid = (await driver.nvim.call(
    "nvim_get_current_win",
    [],
  )) as WindowId;
  return { bufnr, winid, buffer: new NvimBuffer(bufnr, driver.nvim) };
}

async function lua(driver: NvimDriver, code: string, args: unknown[] = []) {
  return driver.nvim.call("nvim_exec_lua", [code, args]);
}

/** Submitting on an idle thread starts a turn; finish it so the comment is no
 * longer pending and the rendering is settled. */
async function settleAutoSend(driver: NvimDriver) {
  (await driver.mockAnthropic.awaitPendingStream()).respond({
    stopReason: "end_turn",
    text: "ok",
    toolRequests: [],
  });
  await driver.assertDisplayBufferContains("ok");
}

/** The float window, once the input has opened. */
async function awaitFloat(driver: NvimDriver): Promise<WindowId> {
  return pollUntil(async () => {
    const wins = (await driver.nvim.call("nvim_list_wins", [])) as WindowId[];
    for (const win of wins) {
      const config = await driver.nvim.call("nvim_win_get_config", [win]);
      if (config.relative === "win") {
        return win;
      }
    }
    throw new Error("no float open");
  });
}

async function awaitNoFloat(driver: NvimDriver): Promise<void> {
  await pollUntil(async () => {
    const wins = (await driver.nvim.call("nvim_list_wins", [])) as WindowId[];
    for (const win of wins) {
      const config = await driver.nvim.call("nvim_win_get_config", [win]);
      if (config.relative === "win") {
        throw new Error("float still open");
      }
    }
  });
}

async function typeIntoFloat(driver: NvimDriver, text: string) {
  const win = await awaitFloat(driver);
  const buf = (await driver.nvim.call("nvim_win_get_buf", [win])) as BufNr;
  await driver.nvim.call("nvim_buf_set_lines", [
    buf,
    0,
    -1,
    false,
    text.split("\n"),
  ]);
}

async function virtLines(buffer: NvimBuffer) {
  const marks = await buffer.getExtmarks(MAGENTA_COMMENT_NAMESPACE);
  const withVirt = marks.find((m) => m.options.virt_lines);
  return (withVirt?.options.virt_lines ?? []).map((chunks) =>
    chunks.map(([t]) => t).join(""),
  );
}

async function highlightedRows(buffer: NvimBuffer) {
  const marks = await buffer.getExtmarks(MAGENTA_COMMENT_NAMESPACE);
  return marks
    .filter((m) => m.options.line_hl_group)
    .map((m) => m.startPos.row)
    .sort((a, b) => a - b);
}

describe("comment input", () => {
  it("comments on a visual selection", async () => {
    await withDriver({}, async (driver) => {
      const { buffer } = await openPoem(driver);
      await driver.showSidebar();
      await driver.editFile("poem.txt");

      await lua(
        driver,
        `vim.api.nvim_win_set_cursor(0, {2, 0})
         vim.fn.setpos("'<", {0, 2, 1, 0})
         vim.fn.setpos("'>", {0, 3, 1, 0})
         require("magenta.keymaps").comment_visual()`,
      );
      await typeIntoFloat(driver, "why is this here?");
      await driver.command("MagentaCommentSubmit");
      await awaitNoFloat(driver);

      await settleAutoSend(driver);
      await pollUntil(async () => {
        expect(await virtLines(buffer)).toEqual(["  you: why is this here?"]);
        expect(await highlightedRows(buffer)).toEqual([1, 2]);
      });
    });
  });

  it("previews the selected range before anything is typed, and clears it on cancel", async () => {
    await withDriver({}, async (driver) => {
      const { buffer } = await openPoem(driver);
      await driver.showSidebar();
      await driver.editFile("poem.txt");

      await lua(
        driver,
        `vim.fn.setpos("'<", {0, 1, 1, 0})
         vim.fn.setpos("'>", {0, 2, 1, 0})
         require("magenta.keymaps").comment_visual()`,
      );
      await awaitFloat(driver);
      await pollUntil(async () => {
        expect(await highlightedRows(buffer)).toEqual([0, 1]);
      });

      await driver.command("MagentaCommentCancel");
      await awaitNoFloat(driver);
      await pollUntil(async () => {
        expect(await highlightedRows(buffer)).toEqual([]);
      });
    });
  });

  it("creates no comment on cancel or on whitespace-only text", async () => {
    await withDriver({}, async (driver) => {
      const { buffer } = await openPoem(driver);
      await driver.showSidebar();
      await driver.editFile("poem.txt");

      await lua(driver, `require("magenta.keymaps").comment()`);
      await awaitFloat(driver);
      await driver.command("MagentaCommentCancel");
      await awaitNoFloat(driver);

      await lua(driver, `require("magenta.keymaps").comment()`);
      await typeIntoFloat(driver, "   \n  ");
      await driver.command("MagentaCommentSubmit");
      await awaitNoFloat(driver);

      expect(await virtLines(buffer)).toEqual([]);
      expect(
        await driver.magenta.getCommentController().extentsInBuffer(buffer.id),
      ).toEqual([]);
    });
  });

  it("follows up on an existing comment rather than creating a second one", async () => {
    await withDriver({}, async (driver) => {
      const { buffer } = await openPoem(driver);
      await driver.showSidebar();
      await driver.editFile("poem.txt");
      const controller = driver.magenta.getCommentController();

      await lua(driver, `vim.api.nvim_win_set_cursor(0, {2, 0})`);
      await lua(driver, `require("magenta.keymaps").comment()`);
      await typeIntoFloat(driver, "first");
      await driver.command("MagentaCommentSubmit");
      await awaitNoFloat(driver);
      await settleAutoSend(driver);
      await pollUntil(async () => {
        expect((await controller.extentsInBuffer(buffer.id)).length).toEqual(1);
      });

      await lua(driver, `require("magenta.keymaps").comment()`);
      await typeIntoFloat(driver, "second");
      await driver.command("MagentaCommentSubmit");
      await awaitNoFloat(driver);

      await settleAutoSend(driver);
      await pollUntil(async () => {
        expect((await controller.extentsInBuffer(buffer.id)).length).toEqual(1);
        expect(await virtLines(buffer)).toEqual([
          "  you: first",
          "  you: second",
          // the comment rode out with a request that is still in flight
          expect.stringMatching(/^ {2}agent: \S$/),
        ]);
      });
    });
  });

  it("opens the follow-up float below the whole transcript", async () => {
    await withDriver({}, async (driver) => {
      const { buffer } = await openPoem(driver);
      await driver.showSidebar();
      await driver.editFile("poem.txt");

      await lua(driver, `vim.api.nvim_win_set_cursor(0, {2, 0})`);
      await lua(driver, `require("magenta.keymaps").comment()`);
      await typeIntoFloat(driver, "first");
      await driver.command("MagentaCommentSubmit");
      await awaitNoFloat(driver);

      // new comment: nothing rendered yet, so the float sits right below the line
      await lua(driver, `vim.api.nvim_win_set_cursor(0, {4, 0})`);
      await lua(driver, `require("magenta.keymaps").comment()`);
      let config = await driver.nvim.call("nvim_win_get_config", [
        await awaitFloat(driver),
      ]);
      expect(config.row).toEqual(1);
      await driver.command("MagentaCommentCancel");
      await awaitNoFloat(driver);

      // follow-up: the float must clear the messages already rendered
      await lua(driver, `vim.api.nvim_win_set_cursor(0, {2, 0})`);
      await lua(driver, `require("magenta.keymaps").comment()`);
      config = await driver.nvim.call("nvim_win_get_config", [
        await awaitFloat(driver),
      ]);
      expect(config.row).toEqual(1 + (await virtLines(buffer)).length);
      await driver.command("MagentaCommentCancel");
      await awaitNoFloat(driver);
    });
  });

  it("caps the transcript while the input is open and restores it after", async () => {
    await withDriver({}, async (driver) => {
      const { buffer } = await openPoem(driver);
      await driver.showSidebar();
      await driver.editFile("poem.txt");
      const controller = driver.magenta.getCommentController();

      await lua(driver, `vim.api.nvim_win_set_cursor(0, {2, 0})`);
      await lua(driver, `require("magenta.keymaps").comment()`);
      await typeIntoFloat(driver, "m0");
      await driver.command("MagentaCommentSubmit");
      await awaitNoFloat(driver);

      await settleAutoSend(driver);
      const [{ id }] = await controller.extentsInBuffer(buffer.id);
      for (const text of ["m1", "m2", "m3", "m4"]) {
        controller.store.addUserMessage(id, text);
      }
      await controller.refreshBuffer(buffer.id);
      expect((await virtLines(buffer)).length).toBeGreaterThan(4);

      await lua(driver, `require("magenta.keymaps").comment()`);
      await awaitFloat(driver);
      await pollUntil(async () => {
        const lines = await virtLines(buffer);
        expect(lines[0]).toContain("earlier message");
        expect(lines.length).toEqual(5); // elision + 3 messages + pending
      });

      await driver.command("MagentaCommentCancel");
      await awaitNoFloat(driver);
      await pollUntil(async () => {
        const lines = await virtLines(buffer);
        expect(lines[0]).toEqual("  you: m0");
      });
    });
  });

  it("deletes the comment under the cursor", async () => {
    await withDriver({}, async (driver) => {
      const { buffer } = await openPoem(driver);
      await driver.showSidebar();
      await driver.editFile("poem.txt");

      await lua(driver, `vim.api.nvim_win_set_cursor(0, {2, 0})`);
      await lua(driver, `require("magenta.keymaps").comment()`);
      await typeIntoFloat(driver, "delete me");
      await driver.command("MagentaCommentSubmit");
      await awaitNoFloat(driver);
      await pollUntil(async () => {
        expect((await virtLines(buffer)).length).toBeGreaterThan(0);
      });

      await lua(driver, `require("magenta.keymaps").comment_delete()`);
      await pollUntil(async () => {
        expect(await virtLines(buffer)).toEqual([]);
        expect(await highlightedRows(buffer)).toEqual([]);
      });
    });
  });

  it("jumps between comments with ]c and [c", async () => {
    await withDriver({}, async (driver) => {
      await openPoem(driver);
      await driver.showSidebar();
      await driver.editFile("poem.txt");

      for (const row of [2, 4]) {
        await lua(driver, `vim.api.nvim_win_set_cursor(0, {${row}, 0})`);
        await lua(driver, `require("magenta.keymaps").comment()`);
        await typeIntoFloat(driver, `comment on ${row}`);
        await driver.command("MagentaCommentSubmit");
        await awaitNoFloat(driver);
      }

      await lua(driver, `vim.api.nvim_win_set_cursor(0, {1, 0})`);
      await lua(driver, `vim.api.nvim_feedkeys("]c", "x", false)`);
      await pollUntil(async () => {
        const [row] = await driver.nvim.call("nvim_win_get_cursor", [0]);
        expect(row).toEqual(2);
      });

      await lua(driver, `vim.api.nvim_win_set_cursor(0, {4, 0})`);
      await lua(driver, `vim.api.nvim_feedkeys("[c", "x", false)`);
      await pollUntil(async () => {
        const [row] = await driver.nvim.call("nvim_win_get_cursor", [0]);
        expect(row).toEqual(2);
      });

      // past the last comment there is nothing to jump to, and the cursor
      // stays where it was
      await lua(driver, `vim.api.nvim_win_set_cursor(0, {4, 0})`);
      await lua(driver, `vim.api.nvim_feedkeys("]c", "x", false)`);
      await pollUntil(async () => {
        const [row] = await driver.nvim.call("nvim_win_get_cursor", [0]);
        expect(row).toEqual(4);
      });
      await lua(driver, `vim.api.nvim_win_set_cursor(0, {1, 0})`);
      await lua(driver, `vim.api.nvim_feedkeys("[c", "x", false)`);
      await pollUntil(async () => {
        const [row] = await driver.nvim.call("nvim_win_get_cursor", [0]);
        expect(row).toEqual(1);
      });
    });
  });

  it("grows with the text and returns the cursor to the target window", async () => {
    await withDriver({}, async (driver) => {
      const { winid } = await openPoem(driver);
      await driver.showSidebar();
      await driver.editFile("poem.txt");

      await lua(driver, `require("magenta.keymaps").comment()`);
      const float = await awaitFloat(driver);
      expect(await driver.nvim.call("nvim_win_get_height", [float])).toEqual(1);

      await typeIntoFloat(driver, "one\ntwo\nthree");
      await lua(
        driver,
        `vim.api.nvim_exec_autocmds("TextChanged", { buffer = ... })`,
        [await driver.nvim.call("nvim_win_get_buf", [float])],
      );
      await pollUntil(async () => {
        expect(await driver.nvim.call("nvim_win_get_height", [float])).toEqual(
          3,
        );
      });

      await driver.command("MagentaCommentCancel");
      await awaitNoFloat(driver);
      expect(await driver.nvim.call("nvim_get_current_win", [])).toEqual(winid);
    });
  });

  it("closes the float when the anchor scrolls out of view", async () => {
    await withDriver({}, async (driver) => {
      const { buffer, winid } = await openPoem(driver);
      await driver.showSidebar();
      await driver.editFile("poem.txt");

      await lua(driver, `require("magenta.keymaps").comment()`);
      await awaitFloat(driver);
      await typeIntoFloat(driver, "never submitted");

      await lua(driver, `vim.fn.win_execute(..., "normal! \\\\<C-e>")`, [
        winid,
      ]);
      await lua(
        driver,
        `vim.api.nvim_exec_autocmds("WinScrolled", { pattern = tostring(...) })`,
        [winid],
      );
      await awaitNoFloat(driver);
      expect(await virtLines(buffer)).toEqual([]);
    });
  });

  it("scrolls the target window so the whole unit fits on screen", async () => {
    await withDriver({}, async (driver) => {
      await openPoem(driver);
      await driver.showSidebar();
      await driver.editFile("poem.txt");

      const winid = (await driver.nvim.call(
        "nvim_get_current_win",
        [],
      )) as WindowId;
      await lua(
        driver,
        `local lines = {}
         for i = 1, 200 do lines[i] = "line " .. i end
         vim.api.nvim_buf_set_lines(0, 0, -1, false, lines)
         local height = vim.api.nvim_win_get_height(0)
         vim.api.nvim_win_set_cursor(0, {height, 0})
         vim.cmd("normal! zb")`,
      );
      const topBefore = (await lua(driver, `return vim.fn.line("w0", ...)`, [
        winid,
      ])) as number;

      await lua(driver, `require("magenta.keymaps").comment()`);
      await awaitFloat(driver);
      const topAfter = (await lua(driver, `return vim.fn.line("w0", ...)`, [
        winid,
      ])) as number;
      expect(topAfter).toBeGreaterThan(topBefore);

      await driver.command("MagentaCommentCancel");
      await awaitNoFloat(driver);
    });
  });

  it("cancels the open input when a second one is requested", async () => {
    await withDriver({}, async (driver) => {
      const { buffer } = await openPoem(driver);
      await driver.showSidebar();
      await driver.editFile("poem.txt");
      const targetWin = (await driver.nvim.call(
        "nvim_get_current_win",
        [],
      )) as WindowId;
      await lua(driver, `vim.api.nvim_win_set_cursor(0, {2, 0})`);
      await lua(driver, `require("magenta.keymaps").comment()`);
      await awaitFloat(driver);
      await typeIntoFloat(driver, "never submitted");

      // request a second input from the target window while the first is open
      await lua(
        driver,
        `vim.api.nvim_set_current_win(...)
         vim.api.nvim_win_set_cursor(0, {4, 0})
         require("magenta.keymaps").comment()`,
        [targetWin],
      );

      await pollUntil(async () => {
        const wins = (await driver.nvim.call(
          "nvim_list_wins",
          [],
        )) as WindowId[];
        const floats = [];
        for (const win of wins) {
          const config = await driver.nvim.call("nvim_win_get_config", [win]);
          if (config.relative === "win") {
            floats.push(win);
          }
        }
        expect(floats.length).toEqual(1);
        // the abandoned input left no comment and no stale preview behind
        expect(await virtLines(buffer)).toEqual([]);
        expect(await highlightedRows(buffer)).toEqual([3]);
      });

      await driver.command("MagentaCommentCancel");
      await awaitNoFloat(driver);
      await pollUntil(async () => {
        expect(await highlightedRows(buffer)).toEqual([]);
      });
    });
  });
  it("scopes comment controllers to the root thread", async () => {
    await withDriver({}, async (driver) => {
      const { buffer } = await openPoem(driver);
      await driver.showSidebar();
      await driver.editFile("poem.txt");
      await lua(driver, `vim.api.nvim_win_set_cursor(0, {2, 0})`);
      await lua(driver, `require("magenta.keymaps").comment()`);
      await typeIntoFloat(driver, "root thread comment");
      await driver.command("MagentaCommentSubmit");
      await awaitNoFloat(driver);
      await pollUntil(async () => {
        expect((await virtLines(buffer)).length).toBeGreaterThan(0);
      });

      const rootId = driver.magenta.chat.getActiveRootThreadId();
      const rootController = driver.magenta.getCommentController();
      expect(rootController.store.listOpenCommentIds().length).toEqual(1);

      await driver.inputMagentaText("spawn a child");
      await driver.send();
      const request =
        await driver.mockAnthropic.awaitPendingStreamWithText("spawn a child");
      request.respond({
        stopReason: "tool_use",
        text: "Spawning.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-comment" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: { agents: [{ prompt: "child" }] },
            },
          },
        ],
      });
      await driver.awaitThreadCount(2);

      const childId = (
        Object.keys(driver.magenta.chat.threadWrappers) as ThreadId[]
      ).find((id) => id !== rootId);
      expect(childId).toBeDefined();
      await driver.magenta.selectThreadEffect(childId as ThreadId);
      // the subagent thread initializes asynchronously
      await pollUntil(() => {
        const wrapper = driver.magenta.chat.threadWrappers[childId as ThreadId];
        if (wrapper?.state !== "initialized") {
          throw new Error("child thread not initialized");
        }
      });
      // a subagent resolves to its root's controller, so it sees the same
      // comments rather than starting an empty side conversation
      expect(driver.magenta.getCommentController()).toBe(rootController);

      await driver.magenta.command("new-thread");
      const otherController = driver.magenta.getCommentController();
      expect(otherController).not.toBe(rootController);
      expect(otherController.store.listOpenCommentIds()).toEqual([]);
    });
  });
  it("no longer offers the clear command", async () => {
    await withDriver({}, async (driver) => {
      const completions = (await lua(
        driver,
        `return vim.fn.getcompletion("Magenta ", "cmdline")`,
      )) as string[];
      expect(completions).not.toContain("clear");
    });
  });
});
