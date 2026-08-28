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
  it("sends an idle-thread comment immediately", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const { buffer } = await openPoem(driver);
      await comment(driver, 1, "why is this here?");

      // an idle thread has nothing to piggyback on, so the comment starts a
      // turn of its own
      const stream = await driver.mockAnthropic.awaitPendingStream();
      const text = commentUpdateText(stream);
      expect(text).toContain("<comment_update>");
      expect(text).toContain("c1 poem.txt:2 (1 new message)");
      expect(text).toContain("<selection>");
      expect(text).toContain("<user>why is this here?</user>");

      // sending clears the pending marker
      await pollUntil(async () => {
        expect(await virtLines(buffer)).toEqual([
          "  you: why is this here?",
          // the turn is still in flight, so the comment shows the agent
          // working on it
          expect.stringMatching(/^ {2}agent: \S$/),
        ]);
      });

      stream.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
    });
  });

  it("batches comments into one block and does not repeat them", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await openPoem(driver);
      await driver.inputMagentaText("look at both");
      await driver.send();
      const first = await driver.mockAnthropic.awaitPendingStream();

      // mid-turn comments accumulate and ride out together
      await driver.editFile("poem.txt");
      await comment(driver, 0, "first");
      await comment(driver, 2, "second");
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

  it("lists an undelivered comment above the input until it is sent", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await openPoem(driver);
      await driver.inputMagentaText("get started");
      await driver.send();
      const first = await driver.mockAnthropic.awaitPendingStream();
      await driver.editFile("poem.txt");
      await comment(driver, 1, "why is this here?");

      await driver.assertDisplayBufferContains(
        "💬 `poem.txt:2` [ pending: 1 new message ]",
      );
      await driver.triggerDisplayBufferKeyOnContent(
        "💬 `poem.txt:2` [ pending: 1 new message ]",
        "=",
      );
      await driver.assertDisplayBufferContains("why is this here?");

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
      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
      await driver.assertDisplayBufferContains("ok");

      await driver.assertDisplayBufferDoesNotContain("[ pending:");
    });
  });

  it("shows a collapsible ledger instead of the raw block", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await openPoem(driver);
      await comment(driver, 1, "why is this here?");

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
      const first = await driver.mockAnthropic.awaitPendingStream();
      expect(commentUpdateText(first)).toContain(
        "<user>why is this here?</user>",
      );
      first.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
      await driver.assertDisplayBufferContains("ok");

      await driver.command(`bwipeout! ${bufnr}`);

      await driver.inputMagentaText("what happened?");
      await driver.send();
      const stream = await driver.mockAnthropic.awaitPendingStream();
      expect(commentUpdateText(stream)).toContain("(closed: buffer unloaded)");
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
  it("does not re-queue a comment when the turn it rode out on is aborted", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await openPoem(driver);
      await comment(driver, 1, "why is this here?");
      const first = await driver.mockAnthropic.awaitPendingStream();
      expect(commentUpdateText(first)).toContain(
        "<user>why is this here?</user>",
      );
      await driver.abort();
      // The block was appended to the message history before the request went
      // out, so aborting does not lose it — and it is not queued a second
      // time, which would duplicate it in the next request.
      await driver.inputMagentaText("actually, nevermind");
      await driver.send();
      const second = await driver.mockAnthropic.awaitPendingStream();
      const blocks = second
        .getProviderMessages()
        .flatMap((m) => m.content)
        .filter((c) => c.type === "comment_update");
      expect(blocks.length).toBe(1);
      expect(blocks[0].text).toContain("<user>why is this here?</user>");
      second.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
    });
  });

  it("preempts an in-flight turn when the send carries pending comments", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await openPoem(driver);
      await driver.inputMagentaText("get started");
      await driver.send();
      const first = await driver.mockAnthropic.awaitPendingStream();
      await driver.editFile("poem.txt");
      await comment(driver, 1, "stop, look at this");
      // The refresh-before-send hop must not delay the send past the abort:
      // this send is what preempts the running turn.
      await driver.inputMagentaText("hold on");
      await driver.send();
      await pollUntil(() => {
        if (!first.aborted) throw new Error("first turn not aborted");
      });
      const second = await driver.mockAnthropic.awaitPendingStream();
      expect(commentUpdateText(second)).toContain(
        "<user>stop, look at this</user>",
      );
      second.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
    });
  });

  it("closes comments on a wiped buffer for every root thread", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const { bufnr } = await openPoem(driver);
      await comment(driver, 1, "thread A comment");
      (await driver.mockAnthropic.awaitPendingStream()).respond({
        stopReason: "end_turn",
        text: "ok",
        toolRequests: [],
      });
      const controllerA = driver.magenta.getCommentController();
      await driver.magenta.command("new-thread");
      await driver.editFile("poem.txt");
      await comment(driver, 3, "thread B comment");
      (await driver.mockAnthropic.awaitPendingStream()).respond({
        stopReason: "end_turn",
        text: "ok",
        toolRequests: [],
      });
      const controllerB = driver.magenta.getCommentController();
      expect(controllerB).not.toBe(controllerA);
      await driver.command(`bwipeout! ${bufnr}`);
      for (const controller of [controllerA, controllerB]) {
        expect(controller.store.listOpenCommentIds()).toEqual([]);
        expect(controller.store.getPendingUpdate()).toContain(
          "(closed: buffer unloaded)",
        );
      }
    });
  });
  it("keeps delivering after a compaction swaps the agent", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await openPoem(driver);
      await driver.inputMagentaText("what is 2+2?");
      await driver.send();
      (await driver.mockAnthropic.awaitPendingStream()).respond({
        stopReason: "end_turn",
        text: "4",
        toolRequests: [],
      });
      await driver.assertDisplayBufferContains("4");
      await driver.inputMagentaText("@compact keep going");
      await driver.send();
      const subagent = await driver.mockAnthropic.awaitPendingStream();
      subagent.respond({
        stopReason: "tool_use",
        text: "compacting",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "edl_1" as never,
              toolName: "edl" as never,
              input: {
                script:
                  "file `/summary.md`\nselect bof-eof\nreplace <<S\n# Summary\narithmetic\nS",
              },
            },
          },
        ],
      });
      (await driver.mockAnthropic.awaitPendingStream()).respond({
        stopReason: "end_turn",
        text: "done",
        toolRequests: [],
      });
      (await driver.mockAnthropic.awaitPendingStream()).respond({
        stopReason: "end_turn",
        text: "ok",
        toolRequests: [],
      });
      await driver.assertDisplayBufferContains("ok");
      // The post-compaction agent reads the thread's store lazily, so a
      // comment left now still rides out.
      await driver.editFile("poem.txt");
      await comment(driver, 1, "post-compaction comment");
      const after = await driver.mockAnthropic.awaitPendingStream();
      expect(commentUpdateText(after)).toContain(
        "<user>post-compaction comment</user>",
      );
      after.respond({ stopReason: "end_turn", text: "ok", toolRequests: [] });
    });
  });
});
