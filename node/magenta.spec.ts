import { describe, expect, it } from "vitest";
import { withDriver } from "./test/preamble";
import { pollUntil } from "./utils/async";
import type { Position0Indexed } from "./nvim/window";
import { LOGO } from "./chat/thread";

describe("node/magenta.spec.ts", () => {
  it("clear command should work", async () => {
    await withDriver({}, async (driver) => {
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
    await withDriver({}, async (driver) => {
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

  it("can switch profiles", async () => {
    await withDriver({}, async (driver) => {
      {
        const state = driver.magenta.chat.state;
        if (state.state != "initialized") {
          throw new Error(`Expected thread to be initialized`);
        }

        expect(state.thread.state.profile).toEqual({
          name: "claude-3-7",
          provider: "anthropic",
          model: "claude-3-7-sonnet-latest",
          apiKeyEnvVar: "ANTHROPIC_API_KEY",
        });
      }
      await driver.showSidebar();
      const displayState = driver.getVisibleState();
      {
        const winbar = await displayState.inputWindow.getOption("winbar");
        expect(winbar).toBe(`Magenta Input (claude-3-7)`);
      }
      await driver.nvim.call("nvim_command", ["Magenta profile gpt-4o"]);
      {
        const state = driver.magenta.chat.state;
        if (state.state != "initialized") {
          throw new Error(`Expected state to be running`);
        }

        expect(state.thread.state.profile).toEqual({
          name: "gpt-4o",
          provider: "openai",
          model: "gpt-4o",
          apiKeyEnvVar: "OPENAI_API_KEY",
        });
        const winbar = await displayState.inputWindow.getOption("winbar");
        expect(winbar).toBe(`Magenta Input (gpt-4o)`);
      }
    });
  });

  it("paste-selection command", async () => {
    await withDriver({}, async (driver) => {
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
});
