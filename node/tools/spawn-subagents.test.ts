import * as fs from "node:fs";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import {
  type EndTurnAction,
  pollUntil,
  type ThreadId,
  type ThreadSupervisor,
  type ToolName,
  type ToolRequestId,
  type YieldAction,
} from "@magenta/core";
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
  expect(childWrapper.state).toBe("initialized");
  if (childWrapper.state !== "initialized")
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

describe("blocking behavior (always blocks)", () => {
  it("waits for subagent completion and returns result", async () => {
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
              id: "test-blocking" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: {
                agents: [{ prompt: "Do a task and report back" }],
              },
            },
          },
        ],
      });

      const subagentStream = await driver.mockAnthropic.awaitPendingStream({
        predicate: (stream) => {
          return stream.messages.some((msg) => {
            if (msg.role !== "user") return false;
            const content = msg.content;
            if (typeof content === "string") {
              return content.includes("Do a task");
            }
            if (Array.isArray(content)) {
              return content.some(
                (block) =>
                  block.type === "text" && block.text.includes("Do a task"),
              );
            }
            return false;
          });
        },
        message: "waiting for subagent stream with task",
      });

      subagentStream.respond({
        stopReason: "tool_use",
        text: "Task complete.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-1" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Found the answer: 42",
              },
            },
          },
        ],
      });

      const parentToolResult =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Found the answer: 42",
        );

      const toolResult = findToolResult(
        parentToolResult.messages,
        "test-blocking",
      );
      expect(toolResult).toBeDefined();
      expect(toolResult!.is_error).toBeFalsy();

      const content =
        typeof toolResult!.content === "string"
          ? toolResult!.content
          : JSON.stringify(toolResult!.content);
      expect(content).toContain("Found the answer: 42");
    });
  });
});

describe("yield behavior", () => {
  it("yield_to_parent submits tool result back to subagent thread", async () => {
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
        text: "Spawning.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-1" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: {
                agents: [{ prompt: "Do the task" }],
              },
            },
          },
        ],
      });

      const subagentStream = await driver.mockAnthropic.awaitPendingStream({
        predicate: (stream) => {
          return stream.messages.some((msg) => {
            if (msg.role !== "user") return false;
            const content = msg.content;
            if (typeof content === "string")
              return content.includes("Do the task");
            if (Array.isArray(content)) {
              return content.some(
                (block) =>
                  block.type === "text" && block.text.includes("Do the task"),
              );
            }
            return false;
          });
        },
        message: "waiting for subagent stream",
      });

      subagentStream.respond({
        stopReason: "tool_use",
        text: "Done with the task.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-1" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: { result: "Task result: success" },
            },
          },
        ],
      });

      const childWrapper = findChildThread(driver.magenta.chat);

      await pollUntil(() => {
        const mode = childWrapper.thread.core.state.mode;
        if (mode.type !== "yielded") {
          throw new Error("yieldedResponse not set yet");
        }
        return mode.response;
      });
      const mode = childWrapper.thread.core.state.mode;
      expect(mode.type).toBe("yielded");
      if (mode.type === "yielded") {
        expect(mode.response).toBe("Task result: success");
      }
    });
  });

  it("supervisor resultPrefix is prepended to yield response", async () => {
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
        text: "Spawning.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-1" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: {
                agents: [{ prompt: "Do the task" }],
              },
            },
          },
        ],
      });

      const subagentStream = await driver.mockAnthropic.awaitPendingStream({
        predicate: (stream) => {
          return stream.messages.some((msg) => {
            if (msg.role !== "user") return false;
            const content = msg.content;
            if (typeof content === "string")
              return content.includes("Do the task");
            if (Array.isArray(content)) {
              return content.some(
                (block) =>
                  block.type === "text" && block.text.includes("Do the task"),
              );
            }
            return false;
          });
        },
        message: "waiting for subagent stream",
      });

      const childWrapper = findChildThread(driver.magenta.chat);
      const mockSupervisor: ThreadSupervisor = {
        onEndTurnWithoutYield: (): EndTurnAction => ({ type: "none" }),
        onYield: async (): Promise<YieldAction> => ({
          type: "accept",
          resultPrefix:
            "[Worker branch: magenta/worker-test123 (forked from main), 2 commit(s) synced to host]",
        }),
      };
      childWrapper.thread.supervisors = [mockSupervisor];

      subagentStream.respond({
        stopReason: "tool_use",
        text: "Done with the task.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-prefix" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: { result: "Completed all changes" },
            },
          },
        ],
      });

      const mode = await pollUntil(() => {
        const m = childWrapper.thread.core.state.mode;
        if (m.type !== "yielded") {
          throw new Error("not yielded yet");
        }
        return m;
      });

      expect(mode.response).toContain("magenta/worker-test123");
      expect(mode.response).toContain("Completed all changes");
      expect(mode.response).toMatch(
        /^\[Worker branch:.*\]\n\nCompleted all changes$/,
      );
      expect(mode.tornDown).toBe(true);
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

  it("uses fast model for subagents when agentType is 'fast-edit'", async () => {
    await withDriver(
      {
        options: {
          profiles: [
            {
              name: "mock",
              provider: "mock",
              model: "mock",
              fastModel: "mock-fast",
              thinkingModel: "mock",
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
        const parentProfile = activeThread.context.profile;

        await driver.inputMagentaText(
          "Use spawn_subagents with fast agent type.",
        );
        await driver.send();

        const stream1 = await driver.mockAnthropic.awaitPendingStreamWithText(
          "Use spawn_subagents",
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
          text: "Using spawn_subagents with fast agent type.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "test-fast" as ToolRequestId,
                toolName: "spawn_subagents" as ToolName,
                input: {
                  agents: [
                    {
                      prompt: "Process this element quickly",
                      agentType: "fast-edit",
                    },
                  ],
                },
              },
            },
          ],
        });

        const subagentStream =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "Process this element quickly",
          );

        expect(subagentStream.params.model).toBe(parentProfile.fastModel);
        expect(subagentStream.params.thinking).toBeUndefined();
      },
    );
  });

  it("uses thinking model for subagents when agentType is 'think'", async () => {
    await withDriver(
      {
        options: {
          profiles: [
            {
              name: "mock",
              provider: "mock",
              model: "mock",
              fastModel: "mock-fast",
              thinkingModel: "mock-thinking",
            },
          ],
          maxConcurrentSubagents: 1,
        },
      },
      async (driver) => {
        await driver.showSidebar();

        const activeThread = driver.magenta.chat.getActiveThread();
        const parentProfile = activeThread.context.profile;

        await driver.inputMagentaText("Use spawn_subagents with think agent.");
        await driver.send();

        const stream1 = await driver.mockAnthropic.awaitPendingStreamWithText(
          "Use spawn_subagents",
        );

        expect(stream1.params.model).toBe(parentProfile.model);

        stream1.respond({
          stopReason: "tool_use",
          text: "Using spawn_subagents with think agent.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "test-think" as ToolRequestId,
                toolName: "spawn_subagents" as ToolName,
                input: {
                  agents: [
                    {
                      prompt: "Reason carefully about this",
                      agentType: "think",
                    },
                  ],
                },
              },
            },
          ],
        });

        const subagentStream =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "Reason carefully about this",
          );

        expect(subagentStream.params.model).toBe(parentProfile.thinkingModel);
        expect(subagentStream.params.thinking).toBeDefined();
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
          if (childWrapper.thread.agent.getState().status.type === "error") {
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

        // Manually recover the errored subagent (this simulates the
        // auto-resubmit mechanism that a later stage will add).
        childWrapper.thread.core.discardFailedSubmit();
        await childWrapper.thread.core.sendMessage([
          { type: "user", text: "error_task" },
        ]);

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

describe("custom agent discovery and spawning", () => {
  it("discovers custom agent, uses its system prompt/reminder, and respects fastModel", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const agentsDir = path.join(tmpDir, ".magenta", "agents");
          await fs.promises.mkdir(agentsDir, { recursive: true });
          await fs.promises.writeFile(
            path.join(agentsDir, "code-review.md"),
            `---
name: code-review
description: Reviews code changes for correctness and style
fastModel: true
---

You are a code review agent. Examine the provided code and identify issues related to correctness, style, and best practices. Be thorough but concise.

<system_reminder>
Always check for proper error handling and type safety.
</system_reminder>
`,
          );
        },
        options: {
          agentsPaths: [".magenta/agents"],
          profiles: [
            {
              name: "mock",
              provider: "mock",
              model: "mock-full",
              fastModel: "mock-fast",
              thinkingModel: "mock",
              thinking: {
                enabled: true,
                budgetTokens: 1024,
              },
            },
          ],
        },
      },
      async (driver) => {
        await driver.showSidebar();

        await driver.inputMagentaText("Review my code changes.");
        await driver.send();

        const parentStream =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "Review my code",
          );

        // Verify the tool spec includes the custom agent in the enum
        const spawnTool = parentStream.params.tools?.find(
          (t) => "name" in t && t.name === "spawn_subagents",
        );
        expect(spawnTool).toBeDefined();
        const toolInput = (
          spawnTool as unknown as {
            input_schema: {
              properties: {
                agents: {
                  items: { properties: { agentType: { enum: string[] } } };
                };
              };
            };
          }
        ).input_schema;
        const agentTypeEnum =
          toolInput.properties.agents.items.properties.agentType.enum;
        expect(agentTypeEnum).toContain("code-review");

        // Verify the tool description includes the custom agent
        expect((spawnTool as { description?: string }).description).toContain(
          "Reviews code changes for correctness and style",
        );

        // Spawn the custom agent
        parentStream.respond({
          stopReason: "tool_use",
          text: "I'll spawn a code-review agent.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "spawn-review" as ToolRequestId,
                toolName: "spawn_subagents" as ToolName,
                input: {
                  agents: [
                    {
                      prompt: "Review the changes in src/main.ts",
                      agentType: "code-review",
                    },
                  ],
                },
              },
            },
          ],
        });

        // Await the subagent stream and verify system prompt
        const subagentStream =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "Review the changes",
          );

        expect(subagentStream.systemPrompt).toContain(
          "You are a code review agent",
        );
        expect(subagentStream.systemPrompt).toContain("<system_reminder>");
        expect(subagentStream.systemPrompt).toContain(
          "Always check for proper error handling and type safety",
        );

        // Verify fastModel is used
        expect(subagentStream.params.model).toBe("mock-fast");
        // Verify thinking is stripped for fast model
        expect(
          (subagentStream.params as Record<string, unknown>).thinking,
        ).toBeUndefined();

        // Have the subagent do a tool call so we can verify the system reminder
        subagentStream.respond({
          stopReason: "tool_use",
          text: "Let me check the file.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "get-file-1" as ToolRequestId,
                toolName: "get_file" as ToolName,
                input: { filePath: "poem.txt" },
              },
            },
          ],
        });

        // After the tool result, the auto-respond should include the custom system reminder
        const autoRespondStream = await driver.mockAnthropic.awaitPendingStream(
          {
            predicate: (stream) => {
              // Look for the stream that has the tool result for get-file-1
              return stream.messages.some((msg) => {
                if (msg.role !== "user" || !Array.isArray(msg.content))
                  return false;
                return (
                  msg.content as Anthropic.Messages.ContentBlockParam[]
                ).some(
                  (block) =>
                    block.type === "tool_result" &&
                    block.tool_use_id === "get-file-1",
                );
              });
            },
            message: "waiting for auto-respond after tool result",
          },
        );

        // Find the system reminder text in the auto-respond messages
        const lastUserMsg =
          autoRespondStream.messages[autoRespondStream.messages.length - 1];
        expect(lastUserMsg.role).toBe("user");
        const lastUserContent =
          lastUserMsg.content as Anthropic.Messages.ContentBlockParam[];
        const reminderBlock = lastUserContent.find(
          (block): block is Anthropic.Messages.TextBlockParam =>
            block.type === "text" && block.text.includes("<system-reminder>"),
        );
        expect(reminderBlock).toBeDefined();
        // Custom reminder should be appended
        expect(reminderBlock!.text).toContain(
          "Always check for proper error handling and type safety",
        );
        // Standard subagent reminders should still be present
        expect(reminderBlock!.text).toContain("yield_to_parent");

        // Yield so test can complete
        autoRespondStream.respond({
          stopReason: "tool_use",
          text: "Review complete.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "yield-review" as ToolRequestId,
                toolName: "yield_to_parent" as ToolName,
                input: { result: "Code looks good" },
              },
            },
          ],
        });

        // Verify parent gets the result
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Code looks good",
        );
      },
    );
  });
});

describe("built-in agents", () => {
  it("built-in explore agent is discoverable in tool spec", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText("Hello");
      await driver.send();

      const stream =
        await driver.mockAnthropic.awaitPendingStreamWithText("Hello");

      const spawnTool = stream.params.tools?.find(
        (t) => "name" in t && t.name === "spawn_subagents",
      );
      expect(spawnTool).toBeDefined();

      const toolInput = (
        spawnTool as unknown as {
          input_schema: {
            properties: {
              agents: {
                items: { properties: { agentType: { enum: string[] } } };
              };
            };
          };
        }
      ).input_schema;
      const agentTypeEnum =
        toolInput.properties.agents.items.properties.agentType.enum;
      expect(agentTypeEnum).toContain("explore");
      expect(agentTypeEnum).not.toContain("plan");
    });
  });
});
