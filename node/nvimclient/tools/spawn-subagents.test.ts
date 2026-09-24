import type Anthropic from "@anthropic-ai/sdk";
import {
  pollUntil,
  type ThreadId,
  type ToolName,
  type ToolRequestId,
} from "@magenta/server";
import { describe, expect, it } from "vitest";
import type { Chat } from "../chat/chat.ts";
import { withDriver } from "../test/preamble.ts";

type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;

function findChildThread(chat: Chat) {
  const childThreadId = Object.keys(chat.threadWrappers).find((id) => {
    const wrapper = chat.threadWrappers[id as ThreadId];
    return wrapper?.parentThreadId !== undefined;
  }) as ThreadId | undefined;
  expect(childThreadId).toBeDefined();
  const childWrapper = chat.threadWrappers[childThreadId!];
  expect(childWrapper?.state).toBe("initialized");
  if (childWrapper?.state !== "initialized")
    throw new Error("Expected initialized");
  return childWrapper;
}

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

it("navigates to spawned subagent thread when pressing Enter on completed summary", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("Use spawn_subagents to do a task.");
    await driver.send();

    const stream1 =
      await driver.mockAnthropic.awaitPendingStreamWithText("spawn_subagents");

    const parentThread = driver.magenta.chat.getActiveThread();
    const parentThreadId = parentThread.id;

    stream1.respond({
      stopReason: "tool_use",
      text: "I'll spawn a subagent to handle this task.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "test-subagent" as ToolRequestId,
            toolName: "spawn_subagents" as ToolName,
            input: {
              agents: [{ prompt: "Do the task and yield the result" }],
            },
          },
        },
      ],
    });

    // Wait for child to start, then yield so spawn_subagents completes
    const childStream =
      await driver.mockAnthropic.awaitPendingStreamWithText("Do the task");
    childStream.respond({
      stopReason: "tool_use",
      text: "Done.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "yield-nav" as ToolRequestId,
            toolName: "yield_to_parent" as ToolName,
            input: { result: "Task done" },
          },
        },
      ],
    });

    // Navigate to the subagent thread by pressing Enter on the completed result row
    await driver.triggerDisplayBufferKeyOnContent(
      "Do the task and yield the result",
      "<CR>",
    );

    await pollUntil(
      () => driver.magenta.chat.getActiveThread().id !== parentThreadId,
    );
  });
});

describe("explore subagent", () => {
  it("spawns explore agent with agentType set to explore", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText("Find where function X is defined.");
      await driver.send();

      const parentStream =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Find where function X is defined",
        );

      parentStream.respond({
        stopReason: "tool_use",
        text: "I'll spawn an explore subagent to find that.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-explore" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: {
                agents: [
                  {
                    prompt: "Find where function X is defined in the codebase",
                    agentType: "explore",
                  },
                ],
              },
            },
          },
        ],
      });

      const subagentStream = await driver.mockAnthropic.awaitPendingStream({
        predicate: (stream) => {
          return (
            stream.systemPrompt?.includes(
              "specialized in searching and understanding codebases",
            ) ?? false
          );
        },
        message: "waiting for explore subagent stream",
      });

      expect(subagentStream.systemPrompt).toContain(
        "specialized in searching and understanding codebases",
      );
    });
  });
});

describe("foreach-style parallel agents", () => {
  it("respects maxConcurrentSubagents limit and processes agents in batches", async () => {
    await withDriver(
      {
        options: { maxConcurrentSubagents: 3 },
      },
      async (driver) => {
        await driver.showSidebar();

        await driver.inputMagentaText(
          "Use spawn_subagents to process 4 tasks.",
        );
        await driver.send();

        const stream1 = await driver.mockAnthropic.awaitPendingStreamWithText(
          "Use spawn_subagents",
        );
        stream1.respond({
          stopReason: "tool_use",
          text: "I'll use spawn_subagents to process 4 tasks in parallel.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "test-subagents" as ToolRequestId,
                toolName: "spawn_subagents" as ToolName,
                input: {
                  agents: [
                    { prompt: "Process element1 and yield the result" },
                    { prompt: "Process element2 and yield the result" },
                    { prompt: "Process element3 and yield the result" },
                    { prompt: "Process element4 and yield the result" },
                  ],
                },
              },
            },
          ],
        });

        const subagent1Stream =
          await driver.mockAnthropic.awaitPendingStreamWithText("element1");
        const subagent2Stream =
          await driver.mockAnthropic.awaitPendingStreamWithText("element2");
        const subagent3Stream =
          await driver.mockAnthropic.awaitPendingStreamWithText("element3");

        await driver.assertDisplayBufferContains("🤖 spawn_subagents");

        // With a concurrency limit of 3, the 4th agent should not spawn yet.
        const unresolvedStreams =
          driver.mockAnthropic.mockClient.streams.filter(
            (s) => !s.aborted && !s.resolved,
          );
        expect(unresolvedStreams.length).toBe(3);

        subagent1Stream.respond({
          stopReason: "tool_use",
          text: "Yielding result for element1.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "yield-element1" as ToolRequestId,
                toolName: "yield_to_parent" as ToolName,
                input: { result: "Processed element1 successfully" },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains(
          "Process element1 and yield the result",
        );

        // Yielding element1 frees a slot, allowing element4 to spawn.
        const subagent4Stream =
          await driver.mockAnthropic.awaitPendingStreamWithText("element4");

        subagent2Stream.respond({
          stopReason: "tool_use",
          text: "Yielding result for element2.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "yield-element2" as ToolRequestId,
                toolName: "yield_to_parent" as ToolName,
                input: { result: "Processed element2 successfully" },
              },
            },
          ],
        });

        subagent3Stream.respond({
          stopReason: "tool_use",
          text: "Yielding result for element3.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "yield-element3" as ToolRequestId,
                toolName: "yield_to_parent" as ToolName,
                input: { result: "Processed element3 successfully" },
              },
            },
          ],
        });

        subagent4Stream.respond({
          stopReason: "tool_use",
          text: "Yielding result for element4.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "yield-element4" as ToolRequestId,
                toolName: "yield_to_parent" as ToolName,
                input: { result: "Processed element4 successfully" },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains("✅ 4 agents");

        const parentStream =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "All sub-agents completed",
          );

        const foreachResponse = findToolResult(
          parentStream.messages,
          "test-subagents",
        );

        expect(foreachResponse).toBeDefined();
        const content =
          typeof foreachResponse!.content === "string"
            ? foreachResponse!.content
            : JSON.stringify(foreachResponse!.content);
        expect(content).toContain("Total: 4");
        expect(content).toContain("Successful: 4");
        expect(content).toContain("Failed: 0");
        expect(content).toContain("Processed element1 successfully");
        expect(content).toContain("Processed element4 successfully");

        parentStream.streamText("All tasks completed successfully.");
        parentStream.finishResponse("end_turn");
      },
    );
  });

  it("keeps a subagent's slot occupied on error instead of freeing it", async () => {
    await withDriver(
      {
        options: { maxConcurrentSubagents: 1 },
      },
      async (driver) => {
        await driver.showSidebar();

        await driver.inputMagentaText(
          "Use spawn_subagents to process 2 tasks.",
        );
        await driver.send();

        const stream1 = await driver.mockAnthropic.awaitPendingStreamWithText(
          "Use spawn_subagents",
        );
        stream1.respond({
          stopReason: "tool_use",
          text: "Processing 2 tasks.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "test-error" as ToolRequestId,
                toolName: "spawn_subagents" as ToolName,
                input: {
                  agents: [
                    { prompt: "error_task" },
                    { prompt: "success_task" },
                  ],
                },
              },
            },
          ],
        });

        const subagent1Stream =
          await driver.mockAnthropic.awaitPendingStreamWithText("error_task");

        subagent1Stream.respondWithError(new Error("Simulated subagent error"));

        await driver.assertDisplayBufferContains("prompt: (~3 tok) error_task");

        const childWrapper = findChildThread(driver.magenta.chat);
        await pollUntil(() => {
          if (childWrapper.thread.thread.lastResult()?.type === "failed") {
            return true;
          }
          throw new Error("waiting for child thread to reach error state");
        });

        // An errored subagent no longer frees its concurrency slot (unlike
        // the old "error == done" behavior), so the second task must not
        // have been spawned yet, and spawn_subagents must not have resolved.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(
          driver.mockAnthropic.mockClient.streams.some((s) =>
            s.messages.some((msg) => {
              if (msg.role !== "user") return false;
              const contentField = msg.content;
              if (typeof contentField === "string") {
                return contentField.includes("success_task");
              }
              if (Array.isArray(contentField)) {
                return contentField.some(
                  (block) =>
                    block.type === "text" &&
                    block.text.includes("success_task"),
                );
              }
              return false;
            }),
          ),
        ).toBe(false);

        // A failed thread is parked, with its log already rolled back, so a
        // fresh send is all the recovery it needs.
        void childWrapper.thread.thread.submit({
          type: "resolved",
          messages: [
            {
              type: "text",
              text: "error_task",
            },
          ],
        });

        const retryStream = await driver.mockAnthropic.awaitPendingStream({
          predicate: (s) => s !== subagent1Stream && !s.resolved,
          message: "waiting for the retried subagent stream",
        });
        retryStream.respond({
          stopReason: "tool_use",
          text: "Yielding after retry.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "yield-retry" as ToolRequestId,
                toolName: "yield_to_parent" as ToolName,
                input: { result: "Recovered successfully" },
              },
            },
          ],
        });

        // Now that the first slot is freed, the second task can spawn.
        const subagent2Stream =
          await driver.mockAnthropic.awaitPendingStreamWithText("success_task");

        subagent2Stream.respond({
          stopReason: "tool_use",
          text: "Yielding success.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "yield-success" as ToolRequestId,
                toolName: "yield_to_parent" as ToolName,
                input: { result: "Successfully processed" },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains("✅ 2 agents");

        const parentStream =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "All sub-agents completed",
          );

        const response = findToolResult(parentStream.messages, "test-error");

        expect(response).toBeDefined();
        const content =
          typeof response!.content === "string"
            ? response!.content
            : JSON.stringify(response!.content);
        expect(content).toContain("Successful: 2");
        expect(content).toContain("Failed: 0");
        expect(content).toContain("Recovered successfully");

        parentStream.streamText("Mixed results.");
        parentStream.finishResponse("end_turn");
      },
    );
  });
});

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
