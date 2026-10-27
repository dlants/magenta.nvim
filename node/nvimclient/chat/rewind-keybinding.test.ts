import { it } from "vitest";
import { withDriver } from "../test/preamble.ts";

it("dd on a user message rewinds the thread to before it", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("What is the capital of France?");
    await driver.send();
    (await driver.mockAnthropic.awaitPendingStream()).respond({
      stopReason: "end_turn",
      text: "The capital of France is Paris.",
      toolRequests: [],
    });

    await driver.inputMagentaText("What about Germany?");
    await driver.send();
    (await driver.mockAnthropic.awaitPendingStream()).respond({
      stopReason: "end_turn",
      text: "The capital of Germany is Berlin.",
      toolRequests: [],
    });
    await driver.assertDisplayBufferContains(
      "The capital of Germany is Berlin.",
    );

    await driver.pressOnDisplayMessage("What about Germany?", "dd");

    await driver.assertDisplayBufferDoesNotContain("What about Germany?");
    await driver.assertDisplayBufferDoesNotContain(
      "The capital of Germany is Berlin.",
    );
    await driver.assertDisplayBufferContains("The capital of France is Paris.");
  });
});

it("dd on a tool row removes the tool_use and its result", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Read the poem");
    await driver.send();
    (await driver.mockAnthropic.awaitPendingStream()).respond({
      stopReason: "tool_use",
      text: "Reading the poem now.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "get-file-1" as never,
            toolName: "get_files" as never,
            input: { files: [{ filePath: "./poem.txt" }] },
          },
        },
      ],
    });
    (await driver.mockAnthropic.awaitPendingStream()).respond({
      stopReason: "end_turn",
      text: "Finished reading.",
      toolRequests: [],
    });
    await driver.assertDisplayBufferContains("Finished reading.");

    await driver.pressOnDisplayMessage("poem.txt", "dd");

    await driver.assertDisplayBufferDoesNotContain("Finished reading.");
    await driver.assertDisplayBufferDoesNotContain("poem.txt");
    await driver.assertDisplayBufferContains("Reading the poem now.");
  });
});
