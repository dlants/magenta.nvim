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

/** Leave a comment on `row` (0-indexed) of the current buffer. */
async function comment(driver: NvimDriver, row: number, text: string) {
  await lua(driver, `vim.api.nvim_win_set_cursor(0, {${row + 1}, 0})`);
  await lua(driver, `require("magenta.keymaps").comment()`);
  const win = await awaitFloat(driver);
  const buf = (await driver.nvim.call("nvim_win_get_buf", [win])) as BufNr;
  await driver.nvim.call("nvim_buf_set_lines", [
    buf,
    0,
    -1,
    false,
    text.split("\n"),
  ]);
  await driver.command("MagentaCommentSubmit");
  await pollUntil(async () => {
    const wins = (await driver.nvim.call("nvim_list_wins", [])) as WindowId[];
    for (const w of wins) {
      const config = await driver.nvim.call("nvim_win_get_config", [w]);
      if (config.relative === "win") {
        throw new Error("float still open");
      }
    }
  });
}

async function openPoem(driver: NvimDriver) {
  await driver.editFile("poem.txt");
  const bufnr = (await driver.nvim.call("nvim_get_current_buf", [])) as BufNr;
  return { bufnr, buffer: new NvimBuffer(bufnr, driver.nvim) };
}

async function virtLines(buffer: NvimBuffer) {
  const marks = await buffer.getExtmarks(MAGENTA_COMMENT_NAMESPACE);
  const withVirt = marks.find((m) => m.options.virt_lines);
  return (withVirt?.options.virt_lines ?? []).map((chunks) =>
    chunks.map(([t]) => t).join(""),
  );
}

/** The `<comment_update>` block of the last user message, if there is one. */
function commentUpdateText(stream: {
  getProviderMessages: () => ReadonlyArray<{
    role: string;
    content: ReadonlyArray<{ type: string; text?: string }>;
  }>;
}): string | undefined {
  const messages = stream.getProviderMessages();
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  return lastUser?.content.find((c) => c.type === "comment_update")?.text;
}

describe("comment delivery", () => {
  it("delivers an idle-thread comment with the user's next message", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const { buffer } = await openPoem(driver);
      await comment(driver, 1, "why is this here?");

      await pollUntil(async () => {
        expect(await virtLines(buffer)).toEqual([
          "  you: why is this here?",
          "  (pending)",
        ]);
      });
      // a comment does not start a turn on its own
      expect(
        driver.magenta.chat.getActiveThread().getProviderMessages().length,
      ).toBe(0);

      await driver.inputMagentaText("take a look");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      const text = commentUpdateText(stream);
      expect(text).toContain("<comment_update>");
      expect(text).toContain("c1 poem.txt:2 (1 new message)");
      expect(text).toContain("<selection>");
      expect(text).toContain("<user>why is this here?</user>");

      // the block precedes the user's own text
      const messages = stream.getProviderMessages();
      const lastUser = [...messages].reverse().find((m) => m.role === "user")!;
      const commentIdx = lastUser.content.findIndex(
        (c) => c.type === "comment_update",
      );
      const textIdx = lastUser.content.findIndex(
        (c) => c.type === "text" && c.text.includes("take a look"),
      );
      expect(commentIdx).toBeGreaterThanOrEqual(0);
      expect(commentIdx).toBeLessThan(textIdx);

      // committing clears the pending marker
      await pollUntil(async () => {
        expect(await virtLines(buffer)).toEqual(["  you: why is this here?"]);
      });

      stream.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
    });
  });

  it("batches comments into one block and does not repeat them", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await openPoem(driver);
      await comment(driver, 0, "first");
      await comment(driver, 2, "second");

      await driver.inputMagentaText("look at both");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      const text = commentUpdateText(stream)!;
      expect(text.indexOf("c1")).toBeLessThan(text.indexOf("c2"));
      expect(text).toContain("<user>first</user>");
      expect(text).toContain("<user>second</user>");
      const blocks = stream
        .getProviderMessages()
        .flatMap((m) => m.content)
        .filter((c) => c.type === "comment_update");
      expect(blocks.length).toBe(1);

      stream.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
      await driver.assertDisplayBufferContains("ok");

      await driver.inputMagentaText("anything else?");
      await driver.send();
      const second = await driver.mockAnthropic.awaitPendingStream();
      const secondBlocks = second
        .getProviderMessages()
        .flatMap((m) => m.content)
        .filter((c) => c.type === "comment_update");
      expect(secondBlocks.length).toBe(1);
      second.respond({ stopReason: "end_turn", text: "no", toolRequests: [] });
    });
  });

  it("shows a collapsible ledger instead of the raw block", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await openPoem(driver);
      await comment(driver, 1, "why is this here?");

      await driver.inputMagentaText("take a look");
      await driver.send();
      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });

      await driver.assertDisplayBufferContains(
        "💬 `poem.txt:2` [ 1 new message ]",
      );
      await driver.assertDisplayBufferDoesNotContain("<comment_update>");
      await driver.assertDisplayBufferDoesNotContain("why is this here?");

      await driver.triggerDisplayBufferKeyOnContent(
        "💬 `poem.txt:2` [ 1 new message ]",
        "=",
      );
      await driver.assertDisplayBufferContains("why is this here?");
    });
  });

  it("delivers a deletion through the same path", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await openPoem(driver);
      await comment(driver, 1, "why is this here?");

      await driver.inputMagentaText("take a look");
      await driver.send();
      const first = await driver.mockAnthropic.awaitPendingStream();
      first.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
      await driver.assertDisplayBufferContains("ok");

      await driver.editFile("poem.txt");
      await lua(driver, `vim.api.nvim_win_set_cursor(0, {2, 0})`);
      await lua(driver, `require("magenta.keymaps").comment_delete()`);

      await driver.inputMagentaText("nevermind");
      await driver.send();
      const stream = await driver.mockAnthropic.awaitPendingStream();
      expect(commentUpdateText(stream)).toContain("c1 poem.txt:2 (deleted)");
      stream.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
    });
  });

  it("closes comments whose buffer was wiped", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const { bufnr } = await openPoem(driver);
      await comment(driver, 1, "why is this here?");

      await driver.command(`bwipeout! ${bufnr}`);

      await driver.inputMagentaText("what happened?");
      await driver.send();
      const stream = await driver.mockAnthropic.awaitPendingStream();
      const text = commentUpdateText(stream)!;
      expect(text).toContain("<user>why is this here?</user>");
      expect(text).toContain("(closed: buffer unloaded)");
      stream.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
    });
  });

  it("does not preempt a turn: a mid-turn comment rides the next request", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await openPoem(driver);

      await driver.inputMagentaText("get started");
      await driver.send();
      const first = await driver.mockAnthropic.awaitPendingStream();
      expect(commentUpdateText(first)).toBeUndefined();

      await driver.editFile("poem.txt");
      await comment(driver, 1, "mid-turn thought");

      first.respond({
        stopReason: "tool_use",
        text: "checking",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "bash-1" as never,
              toolName: "bash_command" as never,
              input: { command: "echo hi" },
            },
          },
        ],
      });

      const second = await driver.mockAnthropic.awaitPendingStream();
      expect(commentUpdateText(second)).toContain(
        "<user>mid-turn thought</user>",
      );
      second.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
    });
  });
});
