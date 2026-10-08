import { expect, it } from "vitest";
import { MAGENTA_REFLECT_NAMESPACE } from "../nvim/buffer.ts";
import { getCurrentWindow } from "../nvim/nvim.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import type { NvimDriver as Driver } from "../test/driver.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

async function setupThread(driver: Driver) {
  await driver.showSidebar();
  await driver.inputMagentaText("Why?");
  await driver.send();
  const r1 = await driver.mockAnthropic.awaitPendingStream();
  r1.respond({
    stopReason: "end_turn",
    text: "Because recursion calls itself.\nSecond line here.",
    toolRequests: [],
  });
  await driver.assertDisplayBufferContains("Second line here.");
  // Let trailing renders (e.g. the title) settle so row lookups stay valid.
  await driver.wait(200);
  return driver.magenta.chat.leftThreadId!;
}

/** Puts the cursor on `text` in the display window and runs `keys` through
 * the real mappings. */
async function visualOn(driver: Driver, text: string, keys: string) {
  const { displayWindow } = driver.getVisibleState();
  const lines = await driver.getDisplayBuffer().getLines({
    start: 0 as Row0Indexed,
    end: -1 as Row0Indexed,
  });
  const row = lines.findIndex((l: string) => l.includes(text));
  if (row === -1) throw new Error(`${text} not in display buffer`);
  const col = Buffer.from(lines[row]).indexOf(text);
  await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
  await driver.nvim.call("nvim_win_set_cursor", [
    displayWindow.id,
    [row + 1, col],
  ]);
  await driver.nvim.call("nvim_command", [`normal ${keys}`]);
}

it("visual r creates an unsent reflect thread anchored on the selection", async () => {
  await withDriver({}, async (driver) => {
    const sourceId = await setupThread(driver);
    const requestsBefore = driver.mockAnthropic.mockClient.streams.length;

    await visualOn(driver, "calls itself", "vlllllllllllr");

    await pollUntil(() => {
      if (driver.magenta.chat.rightThreadId === undefined) {
        throw new Error("still on source");
      }
    });
    const reflectId = driver.magenta.chat.rightThreadId!;
    const origin = driver.magenta.chat.session.getOrigin(reflectId);
    expect(origin).toEqual({
      type: "reflect",
      sourceThreadId: sourceId,
      anchor: { messageIdx: 1, contentIdx: 0, reflectionText: "calls itself" },
    });
    expect(driver.mockAnthropic.mockClient.streams.length).toBe(requestsBefore);

    await pollUntil(async () => {
      const currentWin = await getCurrentWindow(driver.nvim);
      const rightInput = driver.magenta.sidebar.getRightWindows()?.inputWindow;
      if (!rightInput || currentWin.id !== rightInput.id) {
        throw new Error("cursor not in the right input");
      }
    });
    await pollUntil(async () => {
      const mode = (await driver.nvim.call("nvim_get_mode", [])) as {
        mode: string;
      };
      if (mode.mode !== "i") throw new Error(`mode ${mode.mode}`);
    });
    await driver.nvim.call("nvim_command", ["stopinsert"]);
    // Descend so the reflection is in the left column the driver reads.
    await driver.magenta.showReflectionsOverview(reflectId);

    await driver.assertDisplayBufferContains(
      "[thread context]\n\nThe user selected:\n> calls itself",
    );
    await driver.triggerDisplayBufferKeyOnContent("[thread context]", "=");
    await driver.assertDisplayBufferContains("Because recursion calls itself.");
    await driver.assertDisplayBufferContains(
      "The user selected:\n> calls itself",
    );
    await driver.triggerDisplayBufferKeyOnContent("[thread context]", "=");
    await driver.assertDisplayBufferDoesNotContain(
      "Because recursion calls itself.",
    );
  });
});

it("rejects duplicate reflections and selections spanning blocks", async () => {
  await withDriver({}, async (driver) => {
    const sourceId = await setupThread(driver);
    const session = driver.magenta.chat.session;

    await visualOn(driver, "calls itself", "vlllllllllllr");
    await pollUntil(() => {
      if (driver.magenta.chat.rightThreadId === undefined) {
        throw new Error("reflection not shown yet");
      }
    });
    driver.magenta.dispatch({ type: "select-thread-effect", id: sourceId });
    await driver.assertDisplayBufferContains("Second line here.");
    await driver.wait(200);
    await driver.nvim.call("nvim_command", ["stopinsert"]);

    await visualOn(driver, "calls itself", "vlllllllllllr");
    await driver.wait(300);
    expect(session.listDerived(sourceId, "reflect")).toHaveLength(1);
    expect(driver.magenta.chat.rightThreadId).toBeUndefined();
    // Spans the user message and the assistant reply.
    await visualOn(driver, "Why?", "Vjjjjr");
    await driver.wait(300);
    expect(session.listDerived(sourceId, "reflect")).toHaveLength(1);
    expect(driver.magenta.chat.rightThreadId).toBeUndefined();
  });
});

it("linewise V inside one block reflects on the full line", async () => {
  await withDriver({}, async (driver) => {
    const sourceId = await setupThread(driver);
    await visualOn(driver, "Second line here.", "Vr");
    await pollUntil(() => {
      if (driver.magenta.chat.rightThreadId === undefined) {
        throw new Error("still on source");
      }
    });
    const [derived] = driver.magenta.chat.session.listDerived(
      sourceId,
      "reflect",
    );
    expect(
      (derived.origin.anchor as { reflectionText: string }).reflectionText,
    ).toBe("Second line here.");
  });
});
it("highlights reflections, jumps with ]r/[r, and r on a highlight shows it", async () => {
  await withDriver({}, async (driver) => {
    const sourceId = await setupThread(driver);
    await visualOn(driver, "calls itself", "vlllllllllllr");
    const backToSource = async () => {
      await pollUntil(() => {
        if (driver.magenta.chat.rightThreadId === undefined) {
          throw new Error("reflection not shown yet");
        }
      });
      await driver.nvim.call("nvim_command", ["stopinsert"]);
      driver.magenta.dispatch({ type: "select-thread-effect", id: sourceId });
      await driver.assertDisplayBufferContains("Second line here.");
      await driver.wait(200);
    };
    await backToSource();
    await visualOn(driver, "Second line here.", "vlllllr");
    await backToSource();
    const buffer = driver.getDisplayBuffer();
    const marks = await pollUntil(async () => {
      const ms = (await buffer.getExtmarks(MAGENTA_REFLECT_NAMESPACE)).filter(
        (m) => m.options.hl_group === "MagentaReflect",
      );
      if (ms.length !== 2) throw new Error(`marks: ${ms.length}`);
      return ms;
    });
    const lines = await buffer.getLines({
      start: 0 as Row0Indexed,
      end: -1 as Row0Indexed,
    });
    const texts = marks.map((m) =>
      Buffer.from(lines[m.startPos.row])
        .subarray(m.startPos.col, m.endPos.col)
        .toString(),
    );
    expect(texts.sort()).toEqual(["Second", "calls itself"]);
    const labels = (await buffer.getExtmarks(MAGENTA_REFLECT_NAMESPACE))
      .map((m) => m.options.virt_lines?.[0][0][0])
      .filter((t) => t !== undefined);
    expect(labels).toEqual(
      expect.arrayContaining([expect.stringContaining("↳ 1 reflection")]),
    );

    const { displayWindow } = driver.getVisibleState();
    await driver.nvim.call("nvim_set_current_win", [displayWindow.id]);
    await driver.nvim.call("nvim_win_set_cursor", [displayWindow.id, [1, 0]]);
    const cursorAfter = async (keys: string) => {
      await driver.nvim.call("nvim_command", [`normal ${keys}`]);
      return (await driver.nvim.call("nvim_win_get_cursor", [
        displayWindow.id,
      ])) as [number, number];
    };
    const sorted = [...marks].sort((a, b) => a.startPos.row - b.startPos.row);
    const first = sorted[0].startPos;
    const second = sorted[1].startPos;
    expect(await cursorAfter("]r")).toEqual([first.row + 1, first.col]);
    expect(await cursorAfter("]r")).toEqual([second.row + 1, second.col]);
    expect(await cursorAfter("[r")).toEqual([first.row + 1, first.col]);

    // normal r on the highlight shows that reflection
    await driver.nvim.call("nvim_command", ["normal r"]);
    await pollUntil(() => {
      if (driver.magenta.chat.rightThreadId === undefined) {
        throw new Error("still on source");
      }
    });
    const shown = driver.magenta.chat.rightThreadId!;
    expect(driver.magenta.chat.session.getOrigin(shown)).toMatchObject({
      type: "reflect",
      anchor: { reflectionText: "calls itself" },
    });
  });
});
