import { describe, expect, it } from "bun:test";
import { withDriver } from "./test/preamble";
import { pollUntil } from "./utils/async";

describe("bun/magenta.spec.ts", () => {
  it("clear command should work", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`hello`);
      await driver.send();
      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "sup?",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContent(`\
# user:
hello

# assistant:
sup?

Stopped (end_turn)`);

      await driver.clear();
      await driver.assertDisplayBufferContent(`Stopped (end_turn)`);
      await driver.inputMagentaText(`hello again`);
      await driver.send();
      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "huh?",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContent(`\
# user:
hello again

# assistant:
huh?

Stopped (end_turn)`);
    });
  });

  it("can set provider", async () => {
    await withDriver(async (driver) => {
      {
        const state = driver.magenta.chatApp.getState();
        if (state.status != "running") {
          throw new Error(`Expected state to be running`);
        }

        expect(state.model.provider).toBe("anthropic");
      }
      await driver.showSidebar();
      const displayState = driver.getVisibleState();
      {
        const winbar = await displayState.inputWindow.getOption("winbar");
        expect(winbar).toBe(`Magenta Input (anthropic)`);
      }
      await driver.nvim.call("nvim_command", ["Magenta provider openai"]);
      {
        const state = driver.magenta.chatApp.getState();
        if (state.status != "running") {
          throw new Error(`Expected state to be running`);
        }

        expect(state.model.provider).toBe("openai");
      }
      {
        const winbar = await displayState.inputWindow.getOption("winbar");
        expect(winbar).toBe(`Magenta Input (openai)`);
      }
    });
  });

  it("context-file end-to-end", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.nvim.call("nvim_command", [
        "Magenta context-file ./bun/test/fixtures/poem.txt",
      ]);

      await driver.assertDisplayBufferContains(`\
# context:
file: \`./bun/test/fixtures/poem.txt\``);

      await driver.inputMagentaText("check out this file");
      await driver.send();
      await pollUntil(() => {
        if (driver.mockAnthropic.requests.length != 1) {
          throw new Error(`Expected a message to be pending.`);
        }
      });
      const request =
        driver.mockAnthropic.requests[driver.mockAnthropic.requests.length - 1];
      expect(request.messages).toEqual([
        {
          content: [
            {
              text: "check out this file",
              type: "text",
            },
          ],
          role: "user",
        },
        {
          content: `\
Files:
Here are the contents of file \`bun/test/fixtures/poem.txt\`:
\`\`\`
Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.

\`\`\``,
          role: "user",
        },
      ]);
    });
  });
});
