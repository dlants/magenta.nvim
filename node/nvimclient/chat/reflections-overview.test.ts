import type {
  ContentBlockIdx,
  DisplayBufferText,
  MessageIdx,
  ThreadId,
} from "@magenta/server";
import { expect, it } from "vitest";
import { MAGENTA_REFLECT_NAMESPACE } from "../nvim/buffer.ts";
import { getCurrentWindow } from "../nvim/nvim.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import type { NvimDriver as Driver } from "../test/driver.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

const LONG_REPLY = [
  "alpha line",
  ...Array.from({ length: 60 }, (_, i) => `filler ${i}`),
  "omega line",
].join("\n");

async function setupThread(driver: Driver): Promise<ThreadId> {
  await driver.showSidebar();
  await driver.inputMagentaText("Why?");
  await driver.send();
  const r1 = await driver.mockAnthropic.awaitPendingStream();
  r1.respond({ stopReason: "end_turn", text: LONG_REPLY, toolRequests: [] });
  await driver.assertDisplayBufferContains("omega line");
  await driver.wait(200);
  return driver.magenta.chat.leftThreadId!;
}

async function reflect(driver: Driver, source: ThreadId, text: string) {
  return driver.magenta.serverInternals.internals.session.reflectThread(
    source,
    {
      messageIdx: 1 as MessageIdx,
      contentIdx: 0 as ContentBlockIdx,
      reflectionText: text as DisplayBufferText,
    },
  );
}

async function overviewWindow(driver: Driver): Promise<number> {
  return pollUntil(async () => {
    const win = (await getCurrentWindow(driver.nvim)).id;
    if (win === driver.getVisibleState().displayWindow.id) {
      throw new Error("overview not focused");
    }
    return win;
  });
}

async function lines(driver: Driver, win: number): Promise<string[]> {
  const buf = (await driver.nvim.call("nvim_win_get_buf", [win])) as number;
  return (await driver.nvim.call("nvim_buf_get_lines", [
    buf,
    0,
    -1,
    false,
  ])) as string[];
}

it("R opens an empty overview, and - closes it", async () => {
  await withDriver({}, async (driver) => {
    const source = await setupThread(driver);
    const { displayWindow } = driver.getVisibleState();
    await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
    await driver.nvim.call("nvim_win_set_cursor", [displayWindow.id, [1, 0]]);
    await driver.nvim.call("nvim_command", ["normal R"]);
    const win = await overviewWindow(driver);
    await pollUntil(async () => {
      const text = (await lines(driver, win)).join("\n");
      if (!text.includes("No reflections yet")) throw new Error(text);
    });
    expect(driver.magenta.chat.state).toEqual({
      state: "thread-selected",
      left: source,
      right: { type: "reflections-overview" },
    });
    await driver.nvim.call("nvim_command", ["normal -"]);
    await pollUntil(async () => {
      if (await driver.nvim.call("nvim_win_is_valid", [win])) {
        throw new Error("overview still open");
      }
    });
    expect(driver.magenta.chat.state).toEqual({
      state: "thread-selected",
      left: source,
      right: undefined,
    });
  });
});

it("lists reflections in anchor order, centres them, and opens with <CR>", async () => {
  await withDriver({}, async (driver) => {
    const source = await setupThread(driver);
    const omega = await reflect(driver, source, "omega line");
    const alpha = await reflect(driver, source, "alpha line");
    driver.magenta.dispatch({ type: "select-thread-effect", id: source });
    await driver.wait(200);

    const { displayWindow } = driver.getVisibleState();
    await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
    await driver.nvim.call("nvim_command", [":Magenta reflections"]);
    const win = await overviewWindow(driver);
    await pollUntil(async () => {
      const ls = await lines(driver, win);
      if (ls.length < 4) throw new Error(ls.join("\n"));
    });
    // Same block: creation order breaks the tie.
    const ls = await lines(driver, win);
    expect(ls[2]).toContain("> omega line");
    expect(ls[3]).toContain("> alpha line");

    await driver.nvim.call("nvim_win_set_cursor", [win, [4, 0]]);
    await pollUntil(async () => {
      const [row] = (await driver.nvim.call("nvim_win_get_cursor", [
        displayWindow.id,
      ])) as [number, number];
      const displayLines = await driver.getDisplayBuffer().getLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
      });
      if (!displayLines[row - 1].includes("alpha line")) {
        throw new Error(`cursor on ${displayLines[row - 1]}`);
      }
    });
    expect((await getCurrentWindow(driver.nvim)).id).toBe(win);
    expect(driver.magenta.chat.getActiveReflectionId()).toBe(alpha);
    await pollUntil(async () => {
      const active = (
        await driver.getDisplayBuffer().getExtmarks(MAGENTA_REFLECT_NAMESPACE)
      ).filter((m) => m.options.hl_group === "MagentaReflectActive");
      if (active.length !== 1) throw new Error(`active: ${active.length}`);
    });

    await driver.nvim.call("nvim_win_set_cursor", [win, [3, 0]]);
    await pollUntil(() => {
      if (driver.magenta.chat.getActiveReflectionId() !== omega) {
        throw new Error("omega not active");
      }
    });
    // Header rows map to no entry: the active highlight clears.
    await driver.nvim.call("nvim_win_set_cursor", [win, [1, 0]]);
    await pollUntil(async () => {
      if (driver.magenta.chat.getActiveReflectionId() !== undefined) {
        throw new Error("still active");
      }
      const active = (
        await driver.getDisplayBuffer().getExtmarks(MAGENTA_REFLECT_NAMESPACE)
      ).filter((m) => m.options.hl_group === "MagentaReflectActive");
      if (active.length !== 0) throw new Error(`active: ${active.length}`);
    });
    await driver.nvim.call("nvim_win_set_cursor", [win, [3, 0]]);
    await pollUntil(() => {
      if (driver.magenta.chat.getActiveReflectionId() !== omega) {
        throw new Error("omega not active");
      }
    });
    await driver.nvim.call("nvim_command", ['exe "normal \\<CR>"']);
    await pollUntil(() => {
      if (driver.magenta.chat.rightThreadId !== omega) {
        throw new Error("omega not shown");
      }
    });
    // The overview's window now shows the reflection.
    expect(driver.magenta.sidebar.getRightWindows()?.displayWindow.id).toBe(
      win,
    );
    expect(driver.magenta.chat.state).toEqual({
      state: "thread-selected",
      left: source,
      right: { type: "reflection", threadId: omega },
    });
  });
});

it("re-opening reuses the overview, and :q cleans it up", async () => {
  await withDriver({}, async (driver) => {
    const source = await setupThread(driver);
    await reflect(driver, source, "alpha line");
    driver.magenta.dispatch({ type: "select-thread-effect", id: source });
    await driver.wait(200);
    const { displayWindow } = driver.getVisibleState();
    await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
    await driver.nvim.call("nvim_command", [":Magenta reflections"]);
    const win = await overviewWindow(driver);
    const winCount = async () =>
      ((await driver.nvim.call("nvim_list_wins", [])) as number[]).length;
    const before = await winCount();
    await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
    await driver.nvim.call("nvim_command", [":Magenta reflections"]);
    expect(await overviewWindow(driver)).toBe(win);
    expect(await winCount()).toBe(before);

    await driver.nvim.call("nvim_command", ["q"]);
    await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
    // After cleanup, r in the display buffer opens a fresh overview.
    await driver.nvim.call("nvim_win_set_cursor", [displayWindow.id, [1, 0]]);
    await driver.nvim.call("nvim_command", ["normal r"]);
    const reopened = await overviewWindow(driver);
    expect(reopened).not.toBe(win);
    await driver.nvim.call("nvim_command", ["normal -"]);
    await pollUntil(async () => {
      if (await driver.nvim.call("nvim_win_is_valid", [reopened])) {
        throw new Error("overview still open");
      }
    });
  });
});
