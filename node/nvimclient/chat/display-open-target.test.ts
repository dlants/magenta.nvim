import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getAllWindows } from "../nvim/nvim.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

async function installUiOpenMock(
  nvim: import("../nvim/nvim-node/index.ts").Nvim,
): Promise<void> {
  await nvim.call("nvim_exec_lua", [
    `\
vim.g.magenta_test_ui_open = ""
vim.ui.open = function(url)
  vim.g.magenta_test_ui_open = url
  return { wait = function() return 0 end }
end`,
    [],
  ]);
}

describe("node/nvimclient/chat/display-open-target.test.ts", () => {
  it("opens a file path under the cursor in a non-magenta window", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fsPromises.writeFile(
            path.join(tmpDir, "target.txt"),
            "hello file\n",
          );
        },
      },
      async (driver) => {
        await installUiOpenMock(driver.nvim);
        await driver.showSidebar();

        await driver.inputMagentaText("tell me about target.txt");
        await driver.send();

        const request = await driver.mockAnthropic.awaitPendingStream();
        request.streamText("Look at ./target.txt for details.");
        request.finishResponse("end_turn");

        const pos = await driver.assertDisplayBufferContains("./target.txt");
        // Wait a bit for the render to stabilize before triggering the key
        await new Promise((resolve) => setTimeout(resolve, 100));
        await driver.triggerDisplayBufferKey(pos, "<CR>");

        const targetBufferName = await pollUntil(
          async () => {
            const windows = await getAllWindows(driver.nvim);
            for (const w of windows) {
              const isMagenta = await w.getVar("magenta");
              if (isMagenta) continue;
              const buf = await w.buffer();
              const name = await buf.getName();
              if (/target\.txt$/.test(name)) {
                return name;
              }
            }
            throw new Error("target.txt not yet opened in non-magenta window");
          },
          { timeout: 2000 },
        );
        expect(targetBufferName).toMatch(/target\.txt$/);
      },
    );
  });

  it("opens a URL under the cursor via vim.ui.open", async () => {
    await withDriver({}, async (driver) => {
      await installUiOpenMock(driver.nvim);
      await driver.showSidebar();

      await driver.inputMagentaText("show me a link");
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStream();
      request.streamText("See https://example.com for more info.");
      request.finishResponse("end_turn");

      const pos = await driver.assertDisplayBufferContains(
        "https://example.com",
      );
      // Wait a bit for the render to stabilize before triggering the key
      await new Promise((resolve) => setTimeout(resolve, 100));
      await driver.triggerDisplayBufferKey(pos, "<CR>");

      await pollUntil(
        async () => {
          const url = (await driver.nvim.call("nvim_get_var", [
            "magenta_test_ui_open",
          ])) as string;
          if (url !== "https://example.com") {
            throw new Error(
              `vim.ui.open not invoked yet (g:magenta_test_ui_open=${JSON.stringify(url)})`,
            );
          }
          return url;
        },
        { timeout: 2000 },
      );
    });
  });

  it("<CR> still fires existing withBindings handlers", async () => {
    await withDriver({}, async (driver) => {
      await installUiOpenMock(driver.nvim);
      await driver.showSidebar();

      await driver.inputMagentaText("First thread message");
      await driver.send();
      const response = await driver.mockAnthropic.awaitPendingStreamWithText(
        "First thread message",
      );
      response.respond({
        stopReason: "end_turn",
        text: "Assistant reply here.",
        toolRequests: [],
      });

      const thread1 = driver.getThreadId(0);

      await driver.magenta.command("new-thread");
      await driver.awaitThreadCount(2);

      await driver.magenta.command("threads-overview");
      await driver.assertDisplayBufferContains("# Threads");

      const beforeUrl = (await driver.nvim.call("nvim_get_var", [
        "magenta_test_ui_open",
      ])) as string;

      const pos = await driver.assertDisplayBufferContains("Untitled");
      await driver.triggerDisplayBufferKey(pos, "<CR>");

      await driver.awaitChatState({ state: "thread-selected" });

      const afterUrl = (await driver.nvim.call("nvim_get_var", [
        "magenta_test_ui_open",
      ])) as string;
      expect(afterUrl).toBe(beforeUrl);
      expect(driver.getActiveThreadId()).not.toBe(thread1);
    });
  });
});
