import { describe, expect, it } from "vitest";
import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "./toolManager";
import type { ToolName } from "./types";

describe("node/tools/thread-title.spec.ts", () => {
  it("sets thread title after user message", async () => {
    await withDriver({}, async (driver) => {
      // 1. Open the sidebar
      await driver.showSidebar();

      // Verify initial state shows untitled
      await driver.assertDisplayBufferContains("# [ Untitled ]");

      // 2. Send a message
      const userMessage = "Tell me about the solar system";
      await driver.inputMagentaText(userMessage);
      await driver.send();

      // 3. Verify the forceToolUse request was made for thread_title
      const request =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest();

      // Verify the request contains the user message
      expect(request.messages).toMatchObject([
        {
          role: "user",
          content: [
            {
              type: "text",
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              text: expect.stringContaining(userMessage),
            },
          ],
        },
      ]);

      // 4. Respond to the tool use request with a title
      const title = "Exploring the Solar System";
      await driver.mockAnthropic.respondToForceToolUse({
        stopReason: "end_turn",
        toolRequest: {
          status: "ok",
          value: {
            id: "id" as ToolRequestId,
            toolName: "thread_title" as ToolName,
            input: {
              title,
            },
          },
        },
      });

      // 5. Verify the thread title was updated in the display buffer
      await driver.assertDisplayBufferContains(`# ${title}`);

      // Respond to the original user message
      const messageRequest = await driver.mockAnthropic.awaitPendingRequest();
      messageRequest.streamText(
        "The solar system consists of the Sun and everything that orbits around it.",
      );
      messageRequest.finishResponse("end_turn");

      // Verify both the title and message are displayed
      await driver.assertDisplayBufferContains(`# ${title}`);
      await driver.assertDisplayBufferContains(
        "The solar system consists of the Sun and everything that orbits around it.",
      );
    });
  });
});
