import { describe, expect, it } from "vitest";
import { withDriver } from "./test/preamble";
import { pollUntil } from "./utils/async";
import type { Position0Indexed } from "./nvim/window";
import { LOGO } from "./chat/chat";

describe("node/magenta.spec.ts", () => {
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
Stopped (end_turn) [input: 0, output: 0]

Stopped (end_turn)`);

      await driver.clear();
      await driver.assertDisplayBufferContent(LOGO);
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
Stopped (end_turn) [input: 0, output: 0]

Stopped (end_turn)`);
    });
  });

  it("abort command should work", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`hello`);
      await driver.send();
      await driver.assertDisplayBufferContent(`\
# user:
hello

Awaiting response ⠁`);

      await pollUntil(() => {
        if (driver.mockAnthropic.requests.length != 1) {
          throw new Error(`Expected a message to be pending.`);
        }
      });
      const request =
        driver.mockAnthropic.requests[driver.mockAnthropic.requests.length - 1];
      expect(request.defer.resolved).toBe(false);

      await driver.abort();
      expect(request.defer.resolved).toBe(true);
    });
  });

  it("can set provider", async () => {
    await withDriver(async (driver) => {
      {
        const state = driver.magenta.chatApp.getState();
        if (state.status != "running") {
          throw new Error(`Expected state to be running`);
        }

        expect(state.model.providerSetting).toEqual({
          provider: "anthropic",
          model: "claude-3-7-sonnet-latest",
        });
      }
      await driver.showSidebar();
      const displayState = driver.getVisibleState();
      {
        const winbar = await displayState.inputWindow.getOption("winbar");
        expect(winbar).toBe(
          `Magenta Input (anthropic claude-3-7-sonnet-latest)`,
        );
      }
      await driver.nvim.call("nvim_command", ["Magenta provider openai"]);
      {
        const state = driver.magenta.chatApp.getState();
        if (state.status != "running") {
          throw new Error(`Expected state to be running`);
        }

        expect(state.model.providerSetting).toEqual({
          provider: "openai",
          model: "gpt-4o",
          omitParallelToolCalls: false,
        });
        const winbar = await displayState.inputWindow.getOption("winbar");
        expect(winbar).toBe(`Magenta Input (openai gpt-4o)`);
      }

      await driver.nvim.call("nvim_command", [
        "Magenta provider openai o1 omit_parallel_tool_calls",
      ]);
      {
        const state = driver.magenta.chatApp.getState();
        if (state.status != "running") {
          throw new Error(`Expected state to be running`);
        }

        expect(state.model.providerSetting).toEqual({
          provider: "openai",
          model: "o1",
          omitParallelToolCalls: true,
        });
        const winbar = await displayState.inputWindow.getOption("winbar");
        expect(winbar).toBe(`Magenta Input (openai o1)`);
      }
    });
  });

  it("paste-selection command", async () => {
    await withDriver(async (driver) => {
      await driver.editFile("node/test/fixtures/poem.txt");
      await driver.selectRange(
        { row: 0, col: 5 } as Position0Indexed,
        { row: 2, col: 11 } as Position0Indexed,
      );

      await driver.pasteSelection();
      await driver.assertInputBufferContains(`
Here is a snippet from the file \`node/test/fixtures/poem.txt\`
\`\`\`txt
ight whispers through the trees,
Silver shadows dance with ease.
Stars above
\`\`\`
`);
    });
  });

  it("context-files end-to-end", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.nvim.call("nvim_command", [
        "Magenta context-files './node/test/fixtures/poem.txt'",
      ]);

      await driver.assertDisplayBufferContains(`\
# context:
file: \`./node/test/fixtures/poem.txt\``);

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
          content: `\
Here are the contents of file \`node/test/fixtures/poem.txt\`:
\`\`\`
Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.

\`\`\``,
          role: "user",
        },
        {
          content: [
            {
              text: "check out this file",
              type: "text",
            },
          ],
          role: "user",
        },
      ]);
    });
  });

  it("context-files multiple, weird path names", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.nvim.call("nvim_command", [
        "Magenta context-files './node/test/fixtures/poem.txt' './node/test/fixtures/poem 3.txt'",
      ]);

      await driver.assertDisplayBufferContains(`\
# context:
file: \`./node/test/fixtures/poem.txt\`
file: \`./node/test/fixtures/poem 3.txt\``);

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
          content: `\
Here are the contents of file \`node/test/fixtures/poem 3.txt\`:
\`\`\`
poem3

\`\`\``,
          role: "user",
        },
        {
          content: `\
Here are the contents of file \`node/test/fixtures/poem.txt\`:
\`\`\`
Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.

\`\`\``,
          role: "user",
        },
        {
          content: [
            {
              text: "check out this file",
              type: "text",
            },
          ],
          role: "user",
        },
      ]);
    });
  });

  it("context message insert position", async () => {
    await withDriver(async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText(`hello`);
      await driver.send();
      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "sup?",
        toolRequests: [],
      });

      await driver.nvim.call("nvim_command", [
        "Magenta context-files './node/test/fixtures/poem.txt'",
      ]);

      await driver.inputMagentaText("check out this file");
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingRequest();
      expect(request.messages).toEqual([
        {
          content: [
            {
              text: "hello",
              type: "text",
            },
          ],
          role: "user",
        },
        {
          content: [
            {
              text: "sup?",
              type: "text",
            },
          ],
          role: "assistant",
        },
        {
          content: `\
Here are the contents of file \`node/test/fixtures/poem.txt\`:
\`\`\`
Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.

\`\`\``,
          role: "user",
        },
        {
          content: [
            {
              text: "check out this file",
              type: "text",
            },
          ],
          role: "user",
        },
      ]);
    });
  });
});
