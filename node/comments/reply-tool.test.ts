import { getToolSpecs } from "@magenta/core";
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

async function lua(driver: NvimDriver, code: string) {
  return driver.nvim.call("nvim_exec_lua", [code, []]);
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

async function comment(driver: NvimDriver, row: number, text: string) {
  await lua(driver, `vim.api.nvim_win_set_cursor(0, {${row + 1}, 0})`);
  await lua(driver, `require("magenta.keymaps").comment()`);
  const win = await awaitFloat(driver);
  const buf = (await driver.nvim.call("nvim_win_get_buf", [win])) as BufNr;
  await driver.nvim.call("nvim_buf_set_lines", [buf, 0, -1, false, [text]]);
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

/** Every virtual-line block stamped in the buffer, flattened to text. */
async function allVirtLines(buffer: NvimBuffer): Promise<string[]> {
  const marks = await buffer.getExtmarks(MAGENTA_COMMENT_NAMESPACE);
  return marks
    .filter((m) => m.options.virt_lines)
    .flatMap((m) =>
      (m.options.virt_lines ?? []).map((chunks) =>
        chunks.map(([t]) => t).join(""),
      ),
    );
}

async function openPoem(driver: NvimDriver) {
  await driver.editFile("poem.txt");
  const bufnr = (await driver.nvim.call("nvim_get_current_buf", [])) as BufNr;
  return { bufnr, buffer: new NvimBuffer(bufnr, driver.nvim) };
}

function replyRequest(replies: { commentId: string; text: string }[]) {
  return {
    status: "ok" as const,
    value: {
      id: "reply_1" as never,
      toolName: "reply" as never,
      input: { replies } as never,
    },
  };
}

describe("the reply tool", () => {
  it("applies a batch of replies and shows one tool entry", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const { buffer } = await openPoem(driver);
      await comment(driver, 0, "first question");
      await comment(driver, 2, "second question");
      await driver.inputMagentaText("take a look");
      await driver.send();
      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "tool_use",
        text: "replying",
        toolRequests: [
          replyRequest([
            { commentId: "c1", text: "because of X" },
            { commentId: "c2", text: "because of Y" },
          ]),
        ],
      });
      await pollUntil(async () => {
        const lines = await allVirtLines(buffer);
        expect(lines).toContain("  agent: because of X");
        expect(lines).toContain("  agent: because of Y");
      });
      await driver.assertDisplayBufferContains("reply: c1, c2");
      (await driver.mockAnthropic.awaitPendingStream()).respond({
        stopReason: "end_turn",
        text: "done",
        toolRequests: [],
      });
    });
  });

  it("partially succeeds when one id is unknown", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const { buffer } = await openPoem(driver);
      await comment(driver, 0, "first question");
      await driver.inputMagentaText("take a look");
      await driver.send();
      (await driver.mockAnthropic.awaitPendingStream()).respond({
        stopReason: "tool_use",
        text: "replying",
        toolRequests: [
          replyRequest([
            { commentId: "c1", text: "because of X" },
            { commentId: "c99", text: "into the void" },
          ]),
        ],
      });
      const next = await driver.mockAnthropic.awaitPendingStream();
      await pollUntil(async () => {
        expect(await allVirtLines(buffer)).toContain("  agent: because of X");
      });
      const messages = next.getProviderMessages();
      const resultText = JSON.stringify(messages);
      expect(resultText).toContain("c1: replied");
      expect(resultText).toContain("c99: error");
      expect(resultText).toContain("Open comment ids: c1");
      next.respond({ stopReason: "end_turn", text: "done", toolRequests: [] });
    });
  });

  it("is offered to root threads only", () => {
    const mcpToolManager = { getToolSpecs: () => [] };
    const capabilities = new Set([
      "lsp",
      "shell",
      "threads",
      "file-io",
      "scripts",
      "nvim",
      "comments",
    ] as const);
    const names = (threadType: "root" | "subagent") =>
      getToolSpecs(threadType, mcpToolManager, new Set(capabilities)).map(
        (s) => s.name as string,
      );
    expect(names("root")).toContain("reply");
    expect(names("subagent")).not.toContain("reply");
  });

  it("round trips a comment, a reply and a follow-up", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const { buffer } = await openPoem(driver);
      await comment(driver, 0, "why is this here?");
      (await driver.mockAnthropic.awaitPendingStream()).respond({
        stopReason: "tool_use",
        text: "replying",
        toolRequests: [
          replyRequest([{ commentId: "c1", text: "it is a poem" }]),
        ],
      });
      (await driver.mockAnthropic.awaitPendingStream()).respond({
        stopReason: "end_turn",
        text: "done",
        toolRequests: [],
      });
      await driver.assertDisplayBufferContains("done");
      await lua(driver, `vim.cmd("wincmd p")`);
      await comment(driver, 0, "but why here?");
      await pollUntil(async () => {
        expect(await allVirtLines(buffer)).toEqual([
          "  you: why is this here?",
          "  agent: it is a poem",
          "  you: but why here?",
        ]);
      });
      const followup = await driver.mockAnthropic.awaitPendingStream();
      const lastUser = [...followup.getProviderMessages()]
        .reverse()
        .find((m) => m.role === "user")!;
      const block = lastUser.content.find((c) => c.type === "comment_update");
      expect(block?.text).toContain("c1");
      expect(block?.text).toContain("<user>but why here?</user>");
      followup.respond({
        stopReason: "end_turn",
        text: "ok",
        toolRequests: [],
      });
    });
  });
});
