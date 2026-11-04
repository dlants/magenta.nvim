import type { ToolName, ToolRequestId } from "@magenta/server";
import { describe, expect, it } from "vitest";
import { withDriver } from "../test/preamble.ts";

describe("per-agent expansion", () => {
  it("toggles yielded text with = key on single agent result", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText("Spawn a subagent.");
      await driver.send();

      const parentStream =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Spawn a subagent",
        );

      parentStream.respond({
        stopReason: "tool_use",
        text: "Spawning subagent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-expand" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: {
                agents: [{ prompt: "Do a task and report back" }],
              },
            },
          },
        ],
      });

      const subagentStream =
        await driver.mockAnthropic.awaitPendingStreamWithText("Do a task");

      subagentStream.respond({
        stopReason: "tool_use",
        text: "Task complete.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-1" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: { result: "The answer is 42" },
            },
          },
        ],
      });

      // Wait for result to appear
      await driver.assertDisplayBufferContains("Do a task and report back");
      // Let the parent thread finish so the row is the completed result row,
      // not the in-flight progress row.
      const parentResume =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "All sub-agents completed",
        );
      parentResume.respond({
        stopReason: "end_turn",
        text: "All done.",
        toolRequests: [],
      });

      // Verify yielded text is NOT shown initially
      const displayBuffer = driver.getDisplayBuffer();
      const linesBefore = await displayBuffer.getLines({
        start: 0 as import("../nvim/window.ts").Row0Indexed,
        end: -1 as import("../nvim/window.ts").Row0Indexed,
      });
      const contentBefore = linesBefore.join("\n");
      expect(contentBefore).not.toContain("The answer is 42");

      // Press = to expand the agent detail
      await driver.triggerDisplayBufferKeyOnContent(
        "Do a task and report back",
        "=",
      );

      // Verify yielded text IS shown after expansion
      await driver.assertDisplayBufferContains("The answer is 42");
    });
  });

  it("toggles yielded text with = key on multi-agent result", async () => {
    await withDriver(
      { options: { maxConcurrentSubagents: 2 } },
      async (driver) => {
        await driver.showSidebar();

        await driver.inputMagentaText("Spawn multiple subagents.");
        await driver.send();

        const parentStream =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "Spawn multiple",
          );

        parentStream.respond({
          stopReason: "tool_use",
          text: "Spawning agents.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "test-multi" as ToolRequestId,
                toolName: "spawn_subagents" as ToolName,
                input: {
                  agents: [
                    { prompt: "First task agent" },
                    { prompt: "Second task agent" },
                  ],
                },
              },
            },
          ],
        });

        const sub1 =
          await driver.mockAnthropic.awaitPendingStreamWithText("First task");
        const sub2 =
          await driver.mockAnthropic.awaitPendingStreamWithText("Second task");

        sub1.respond({
          stopReason: "tool_use",
          text: "Done first.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "yield-first" as ToolRequestId,
                toolName: "yield_to_parent" as ToolName,
                input: { result: "Result from first agent" },
              },
            },
          ],
        });

        sub2.respond({
          stopReason: "tool_use",
          text: "Done second.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "yield-second" as ToolRequestId,
                toolName: "yield_to_parent" as ToolName,
                input: { result: "Result from second agent" },
              },
            },
          ],
        });

        // Wait for completed results
        await driver.assertDisplayBufferContains("First task agent");

        // Let the parent thread finish so the display buffer is stable
        const parentResume =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "All sub-agents completed",
          );
        parentResume.respond({
          stopReason: "end_turn",
          text: "All done.",
          toolRequests: [],
        });

        await driver.assertDisplayBufferContains("All done.");

        // Press = on first agent to expand it
        await driver.triggerDisplayBufferKeyOnContent(
          "prompt: (~4 tok) First task agent",
          "=",
        );

        // Verify first agent's yielded text is shown
        await driver.assertDisplayBufferContains("Result from first agent");

        // Verify second agent's yielded text is NOT shown
        const displayBuffer = driver.getDisplayBuffer();
        const lines = await displayBuffer.getLines({
          start: 0 as import("../nvim/window.ts").Row0Indexed,
          end: -1 as import("../nvim/window.ts").Row0Indexed,
        });
        const content = lines.join("\n");
        expect(content).not.toContain("Result from second agent");
      },
    );
  });
});
