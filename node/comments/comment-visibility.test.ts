import { describe, expect, it } from "vitest";
import {
  type BufNr,
  MAGENTA_COMMENT_ANCHOR_NAMESPACE,
  MAGENTA_COMMENT_NAMESPACE,
  NvimBuffer,
} from "../nvim/buffer.ts";
import type { WindowId } from "../nvim/window.ts";
import type { NvimDriver } from "../test/driver.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

async function lua(driver: NvimDriver, code: string, args: unknown[] = []) {
  return driver.nvim.call("nvim_exec_lua", [code, args]);
}

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

async function virtLines(buffer: NvimBuffer) {
  const marks = await buffer.getExtmarks(MAGENTA_COMMENT_NAMESPACE);
  return marks
    .filter((m) => m.options.virt_lines)
    .flatMap((m) =>
      (m.options.virt_lines ?? []).map((chunks) =>
        chunks.map(([t]) => t).join(""),
      ),
    );
}

/** Leave a comment on line `row` (1-indexed) of the current buffer. */
async function comment(driver: NvimDriver, row: number, text: string) {
  await lua(driver, `vim.api.nvim_win_set_cursor(0, {${row}, 0})`);
  await lua(driver, `require("magenta.keymaps").comment()`);
  const win = await awaitFloat(driver);
  const buf = (await driver.nvim.call("nvim_win_get_buf", [win])) as BufNr;
  await driver.nvim.call("nvim_buf_set_lines", [buf, 0, -1, false, [text]]);
  await driver.command("MagentaCommentSubmit");
  await awaitNoFloat(driver);
}

async function openPoem(driver: NvimDriver) {
  await driver.editFile("poem.txt");
  const bufnr = (await driver.nvim.call("nvim_get_current_buf", [])) as BufNr;
  return { bufnr, buffer: new NvimBuffer(bufnr, driver.nvim) };
}

describe("comment visibility across threads", () => {
  it("hides comments on thread switch and restores them on switch back", async () => {
    await withDriver({}, async (driver) => {
      const { buffer } = await openPoem(driver);
      await driver.showSidebar();
      await driver.editFile("poem.txt");

      await comment(driver, 2, "first message");
      const threadA = driver.magenta.chat.getActiveRootThreadId();
      const controllerA = driver.magenta.getCommentController();
      const commentId = controllerA.store.listOpenCommentIds()[0];
      controllerA.store.addUserMessage(commentId, "second message");

      await pollUntil(async () => {
        expect((await virtLines(buffer)).length).toBeGreaterThanOrEqual(2);
      });

      await driver.magenta.command("new-thread");
      await pollUntil(async () => {
        expect(await virtLines(buffer)).toEqual([]);
      });

      await driver.magenta.selectThreadEffect(threadA);
      await pollUntil(async () => {
        const lines = await virtLines(buffer);
        expect(lines).toContain("  you: first message");
        expect(lines).toContain("  you: second message");
      });
    });
  });

  it("shows only the active thread's comments in a re-opened window", async () => {
    await withDriver({}, async (driver) => {
      const { buffer } = await openPoem(driver);
      await driver.showSidebar();
      await driver.editFile("poem.txt");
      await comment(driver, 2, "thread A comment");
      const threadA = driver.magenta.chat.getActiveRootThreadId();

      await driver.magenta.command("new-thread");
      await driver.editFile("poem.txt");
      await comment(driver, 4, "thread B comment");

      // re-open the file in a fresh window; BufEnter re-stamps the active
      // thread's comments and nothing else
      await lua(driver, `vim.cmd("split poem.txt")`);
      await pollUntil(async () => {
        expect(await virtLines(buffer)).toEqual([
          "  you: thread B comment",
          "  (pending)",
        ]);
      });

      // switching back must hide B before stamping A: both threads comment on
      // this same buffer, so a show-then-hide order would wipe A's stamps.
      await driver.magenta.selectThreadEffect(threadA);
      await pollUntil(async () => {
        expect(await virtLines(buffer)).toEqual([
          "  you: thread A comment",
          "  (pending)",
        ]);
      });

      // the overview doesn't select a different conversation, so it leaves the
      // decorations alone
      driver.magenta.dispatch({
        type: "chat-msg",
        msg: { type: "threads-overview" },
      });
      await pollUntil(async () => {
        expect(await virtLines(buffer)).toEqual([
          "  you: thread A comment",
          "  (pending)",
        ]);
      });
    });
  });

  it("leaves no extmarks behind when a thread is deleted", async () => {
    await withDriver({}, async (driver) => {
      const { buffer } = await openPoem(driver);
      await driver.showSidebar();
      await driver.editFile("poem.txt");
      await comment(driver, 2, "doomed comment");

      const threadId = driver.magenta.chat.getActiveRootThreadId();
      await driver.magenta.command("new-thread");
      driver.magenta.dispatch({
        type: "chat-msg",
        msg: { type: "delete-thread-subtree", id: threadId },
      });

      await pollUntil(async () => {
        expect(driver.magenta.chat.threadWrappers[threadId]).toBeUndefined();
        expect(await virtLines(buffer)).toEqual([]);
        expect(
          await buffer.getExtmarks(MAGENTA_COMMENT_ANCHOR_NAMESPACE),
        ).toEqual([]);
      });
    });
  });
});
