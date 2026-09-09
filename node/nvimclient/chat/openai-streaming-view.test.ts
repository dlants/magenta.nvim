import { describe, it } from "vitest";
import { withDriver } from "../test/preamble.ts";

describe("OpenAI streaming view", () => {
  it("renders completed blocks while the rest of the turn is still streaming", async () => {
    await withDriver({ agentKind: "openai" }, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("look up denis lantsman");
      await driver.send();

      const stream = await driver.mockOpenAI.awaitStream();
      stream.streamReasoningSummary(["let me look that up"]);
      stream.streamWebSearchCall("denis lantsman");
      await stream.settle();

      // The turn is still open: these must already be on screen rather than
      // appearing all at once when the response completes.
      await driver.assertDisplayBufferContains("💭 [Thinking]");
      await driver.assertDisplayBufferContains("🔍 Searching denis lantsman");

      stream.streamText("Denis is a software engineer.");
      stream.finishResponse("end_turn");
      await driver.assertDisplayBufferContains("Denis is a software engineer.");
    });
  });
});
