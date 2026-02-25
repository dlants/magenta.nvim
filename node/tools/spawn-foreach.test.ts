import { withDriver } from "../test/preamble.ts";
import { it, expect } from "vitest";
import type { ToolRequestId, ToolName } from "@magenta/core";
import type Anthropic from "@anthropic-ai/sdk";
import { pollUntil } from "@magenta/core";

type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;

function findToolResult(
  messages: Anthropic.MessageParam[],
  toolUseId: string,
): ToolResultBlockParam | undefined {
  for (const msg of messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const result = msg.content.find(
        (block): block is ToolResultBlockParam =>
          block.type === "tool_result" && block.tool_use_id === toolUseId,
      );
      if (result) return result;
    }
  }
  return undefined;
}

it("respects maxConcurrentSubagents limit and processes elements in batches", async () => {
  await withDriver(
    {
      options: { maxConcurrentSubagents: 3 },
    },
    async (driver) => {
      await driver.showSidebar();

      // Create a foreach request with 4 elements (more than the limit of 3)
      await driver.inputMagentaText(
        "Use spawn_foreach to process 4 elements concurrently.",
      );
      await driver.send();

      const stream1 =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Use spawn_foreach",
        );
      stream1.respond({
        stopReason: "tool_use",
        text: "I'll use spawn_foreach to process 4 elements in parallel.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-foreach" as ToolRequestId,
              toolName: "spawn_foreach" as ToolName,
              input: {
                prompt: "Process this element and yield the result",
                elements: ["element1", "element2", "element3", "element4"],
              },
            },
          },
        ],
      });

      // The first 3 subagents should start running
      const subagent1Stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("element1");
      const subagent2Stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("element2");
      const subagent3Stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("element3");

      // Now we should see 3 running and 1 pending
      await driver.assertDisplayBufferContains("🤖⏳ Foreach subagents (0/4):");
      await driver.assertDisplayBufferContains("- element1: ⏳");
      await driver.assertDisplayBufferContains("- element2: ⏳");
      await driver.assertDisplayBufferContains("- element3: ⏳");
      await driver.assertDisplayBufferContains("- element4: ⏸️");

      // Complete the first subagent
      subagent1Stream.respond({
        stopReason: "tool_use",
        text: "I'll yield the result for element1.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-element1" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Processed element1 successfully",
              },
            },
          },
        ],
      });

      // After element1 completes, element4 should start and element1 should show as completed
      await driver.assertDisplayBufferContains("🤖⏳ Foreach subagents (1/4):");
      await driver.assertDisplayBufferContains("- element1: ✅");

      // The 4th subagent should now start
      const subagent4Stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("element4");

      // Verify element4 is now running
      await driver.assertDisplayBufferContains("- element4: ⏳");

      // Complete the remaining 3 subagents
      subagent2Stream.respond({
        stopReason: "tool_use",
        text: "I'll yield the result for element2.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-element2" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Processed element2 successfully",
              },
            },
          },
        ],
      });

      subagent3Stream.respond({
        stopReason: "tool_use",
        text: "I'll yield the result for element3.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-element3" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Processed element3 successfully",
              },
            },
          },
        ],
      });

      subagent4Stream.respond({
        stopReason: "tool_use",
        text: "I'll yield the result for element4.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-element4" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Processed element4 successfully",
              },
            },
          },
        ],
      });

      // All elements should now be completed
      await driver.assertDisplayBufferContains("🤖✅ Foreach subagents (4/4)");

      // The parent thread should receive the foreach tool result
      const parentStream =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Foreach subagent execution completed",
        );

      // Verify the tool response contains all subagent results
      const foreachResponse = findToolResult(
        parentStream.messages,
        "test-foreach",
      );

      expect(foreachResponse).toBeDefined();
      const content =
        typeof foreachResponse!.content === "string"
          ? foreachResponse!.content
          : JSON.stringify(foreachResponse!.content);
      expect(content).toContain("Total elements: 4");
      expect(content).toContain("Successful: 4");
      expect(content).toContain("Failed: 0");
      expect(content).toContain("- element1: Processed element1 successfully");
      expect(content).toContain("- element2: Processed element2 successfully");
      expect(content).toContain("- element3: Processed element3 successfully");
      expect(content).toContain("- element4: Processed element4 successfully");

      parentStream.streamText(
        "All foreach subagents have completed successfully.",
      );
      parentStream.finishResponse("end_turn");
    },
  );
});

it("uses fast model for subagents when agentType is 'fast'", async () => {
  await withDriver(
    {
      options: {
        profiles: [
          {
            name: "mock",
            provider: "mock",
            model: "mock",
            fastModel: "mock-fast",
            thinking: {
              enabled: true,
              budgetTokens: 1024,
            },
          },
        ],
        maxConcurrentSubagents: 1,
      },
    },
    async (driver) => {
      await driver.showSidebar();

      const activeThread = driver.magenta.chat.getActiveThread();
      const parentProfile = activeThread.state.profile;

      await driver.inputMagentaText(
        "Use spawn_foreach with fast agent type to process 1 element.",
      );
      await driver.send();

      const stream1 =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Use spawn_foreach",
        );

      expect(
        stream1.params.thinking,
        "parent request thinking is enabled",
      ).toEqual({
        type: "enabled",
        budget_tokens: 1024,
      });

      stream1.respond({
        stopReason: "tool_use",
        text: "I'll use spawn_foreach with fast agent type.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-foreach-fast" as ToolRequestId,
              toolName: "spawn_foreach" as ToolName,
              input: {
                prompt: "Process this element quickly",
                elements: ["test_element"],
                agentType: "fast",
              },
            },
          },
        ],
      });

      // The subagent should start running
      const subagentStream =
        await driver.mockAnthropic.awaitPendingStreamWithText("test_element");

      // Verify that the subagent request uses the fast model
      expect(subagentStream.params.model).toBe(parentProfile.fastModel);

      // Verify that reasoning is disabled for the fast subagent
      // even though the parent profile has reasoning enabled
      expect(subagentStream.params.thinking).toBeUndefined();
    },
  );
});

it("handles subagent errors gracefully and continues processing remaining elements", async () => {
  await withDriver(
    {
      options: { maxConcurrentSubagents: 1 },
    },
    async (driver) => {
      await driver.showSidebar();

      // Create a foreach request with 2 elements, first will error
      await driver.inputMagentaText(
        "Use spawn_foreach to process 2 elements, first will fail.",
      );
      await driver.send();

      const stream1 =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Use spawn_foreach",
        );
      stream1.respond({
        stopReason: "tool_use",
        text: "I'll use spawn_foreach to process 2 elements.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-foreach-error" as ToolRequestId,
              toolName: "spawn_foreach" as ToolName,
              input: {
                prompt: "Process this element",
                elements: ["error_element", "success_element"],
              },
            },
          },
        ],
      });

      // First subagent should start (error_element)
      const subagent1Stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("error_element");

      // Verify initial state: 1 running, 1 pending
      await driver.assertDisplayBufferContains("🤖⏳ Foreach subagents (0/2):");
      await driver.assertDisplayBufferContains("- error_element: ⏳");
      await driver.assertDisplayBufferContains("- success_element: ⏸️");

      // First subagent encounters an error
      subagent1Stream.respondWithError(new Error("Simulated subagent error"));

      // Verify error_element shows as error state
      await driver.assertDisplayBufferContains("- error_element: ❌");

      // After error_element fails, success_element should start
      const subagent2Stream =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "success_element",
        );

      // Second subagent succeeds
      subagent2Stream.respond({
        stopReason: "tool_use",
        text: "I'll yield a successful result.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-success" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Successfully processed success_element",
              },
            },
          },
        ],
      });

      // All elements should now be completed (1 success, 1 error)
      await driver.assertDisplayBufferContains("🤖✅ Foreach subagents (2/2)");

      // The parent thread should receive the foreach tool result
      const parentStream =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Foreach subagent execution completed",
        );

      // Verify the tool response contains results from both subagents
      const foreachResponse = findToolResult(
        parentStream.messages,
        "test-foreach-error",
      );

      expect(foreachResponse).toBeDefined();

      const content =
        typeof foreachResponse!.content === "string"
          ? foreachResponse!.content
          : JSON.stringify(foreachResponse!.content);
      expect(content).toContain("Total elements: 2");
      expect(content).toContain("Successful: 1");
      expect(content).toContain("Failed: 1");
      expect(content).toContain(
        "- success_element: Successfully processed success_element",
      );
      expect(content).toContain("- error_element:");

      parentStream.streamText(
        "Foreach subagents completed with mixed results.",
      );
      parentStream.finishResponse("end_turn");
    },
  );
});

it("aborts all child threads when the foreach request is aborted", async () => {
  await withDriver(
    {
      options: { maxConcurrentSubagents: 2 },
    },
    async (driver) => {
      await driver.showSidebar();

      // Create a foreach request with 3 elements
      await driver.inputMagentaText("Use spawn_foreach to process 3 elements.");
      await driver.send();

      const stream1 =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Use spawn_foreach",
        );
      stream1.respond({
        stopReason: "tool_use",
        text: "I'll use spawn_foreach to process 3 elements.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-foreach-abort" as ToolRequestId,
              toolName: "spawn_foreach" as ToolName,
              input: {
                prompt: "Process this element",
                elements: ["element1", "element2", "element3"],
              },
            },
          },
        ],
      });

      // First 2 subagents should start running (due to maxConcurrentSubagents: 2)
      const subagent1Stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("element1");
      const subagent2Stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("element2");

      // Verify initial state: 2 running, 1 pending
      await driver.assertDisplayBufferContains("🤖⏳ Foreach subagents (0/3):");
      await driver.assertDisplayBufferContains("- element1: ⏳");
      await driver.assertDisplayBufferContains("- element2: ⏳");
      await driver.assertDisplayBufferContains("- element3: ⏸️");

      // Abort the chat (which should abort all running tools including foreach)
      await driver.abort();

      // Verify that both running subagent requests were aborted
      expect(subagent1Stream.aborted).toBe(true);
      expect(subagent2Stream.aborted).toBe(true);

      // Verify that the foreach tool shows as aborted/error state
      await driver.assertDisplayBufferContains("🤖❌ Foreach subagents");

      // Verify no third subagent was started for element3
      // (since the foreach was aborted before element3 could start)
      expect(driver.mockAnthropic.hasPendingStreamWithText("element3")).toBe(
        false,
      );
    },
  );
});

it("navigates to spawned subagent thread when pressing Enter on completed summary thread link", async () => {
  await withDriver(
    {
      options: { maxConcurrentSubagents: 1 },
    },
    async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText("Use spawn_foreach to process 1 element.");
      await driver.send();

      const stream1 =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Use spawn_foreach",
        );

      stream1.respond({
        stopReason: "tool_use",
        text: "I'll use spawn_foreach to process 1 element.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-foreach-nav" as ToolRequestId,
              toolName: "spawn_foreach" as ToolName,
              input: {
                prompt: "Process this element and yield the result",
                elements: ["test_element"],
              },
            },
          },
        ],
      });

      // The subagent should start running
      const subagentStream =
        await driver.mockAnthropic.awaitPendingStreamWithText("test_element");

      // Complete the subagent
      subagentStream.respond({
        stopReason: "tool_use",
        text: "I'll yield the result.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-test" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Processed test_element successfully",
              },
            },
          },
        ],
      });

      // Wait for the completed summary to appear
      await driver.assertDisplayBufferContains("🤖✅ Foreach subagents (1/1)");

      // Get the spawned thread id (it's the second thread created)
      const subagentThreadId = driver.getThreadId(1);

      // Press Enter on the Foreach subagents summary to navigate to the subagent thread
      await driver.triggerDisplayBufferKeyOnContent(
        "🤖✅ Foreach subagents (1/1)",
        "<CR>",
      );

      // Verify we navigated to the subagent thread
      await pollUntil(
        () => driver.magenta.chat.getActiveThread().id === subagentThreadId,
      );
    },
  );
});
