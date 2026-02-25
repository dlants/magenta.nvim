import { withDriver } from "../test/preamble.ts";
import { describe, expect, it } from "vitest";
import { type ToolRequestId, type ToolName, pollUntil } from "@magenta/core";
import { EXPLORE_SUBAGENT_SYSTEM_PROMPT } from "../providers/system-prompt.ts";
import type Anthropic from "@anthropic-ai/sdk";

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

it("navigates to spawned subagent thread when pressing Enter on completed summary", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("Use spawn_subagent to do a task.");
    await driver.send();

    const stream1 =
      await driver.mockAnthropic.awaitPendingStreamWithText("spawn_subagent");

    // Get the active thread before navigation
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
            toolName: "spawn_subagent" as ToolName,
            input: {
              prompt: "Do the task and yield the result",
            },
          },
        },
      ],
    });

    // Wait for the completed summary to appear
    const summaryPos =
      await driver.assertDisplayBufferContains("🤖✅ spawn_subagent");

    // Press Enter on the completed summary to navigate to the subagent thread
    await driver.triggerDisplayBufferKey(summaryPos, "<CR>");

    // Verify we navigated to a different thread (the subagent)
    await pollUntil(
      () => driver.magenta.chat.getActiveThread().id !== parentThreadId,
    );
  });
});

describe("explore subagent", () => {
  it("creates subagent_explore thread with explore system prompt", async () => {
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
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Find where function X is defined in the codebase",
                agentType: "explore",
              },
            },
          },
        ],
      });

      // Wait for the subagent stream - it will have the explore system prompt
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

      // Verify the system prompt contains the explore-specific instructions
      expect(subagentStream.systemPrompt).toContain(
        EXPLORE_SUBAGENT_SYSTEM_PROMPT.substring(0, 100),
      );
      expect(subagentStream.systemPrompt).toContain(
        "explore subagent specialized in searching",
      );
      expect(subagentStream.systemPrompt).toContain(
        "File paths with line ranges",
      );
    });
  });
});

describe("blocking option", () => {
  it("returns immediately with threadId when blocking=false (default)", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText("Spawn a non-blocking subagent.");
      await driver.send();

      const parentStream =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Spawn a non-blocking subagent",
        );

      parentStream.respond({
        stopReason: "tool_use",
        text: "Spawning subagent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-nonblocking" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Do a quick task",
                blocking: false,
              },
            },
          },
        ],
      });

      // The parent should immediately get the tool result with threadId
      const toolResultStream =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Sub-agent started with threadId:",
        );

      // Verify the tool result contains threadId using the helper
      const toolResult = findToolResult(
        toolResultStream.messages,
        "test-nonblocking",
      );
      expect(toolResult).toBeDefined();
      expect(toolResult!.is_error).toBeFalsy();

      const content =
        typeof toolResult!.content === "string"
          ? toolResult!.content
          : JSON.stringify(toolResult!.content);
      expect(content).toContain("Sub-agent started with threadId:");
    });
  });

  it("waits for subagent completion when blocking=true", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText("Spawn a blocking subagent.");
      await driver.send();

      const parentStream =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Spawn a blocking subagent",
        );

      parentStream.respond({
        stopReason: "tool_use",
        text: "Spawning blocking subagent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-blocking" as ToolRequestId,
              toolName: "spawn_subagent" as ToolName,
              input: {
                prompt: "Do a blocking task and report back",
                blocking: true,
              },
            },
          },
        ],
      });

      // Wait for the subagent stream
      const subagentStream = await driver.mockAnthropic.awaitPendingStream({
        predicate: (stream) => {
          // The subagent stream will have messages containing the prompt
          return stream.messages.some((msg) => {
            if (msg.role !== "user") return false;
            const content = msg.content;
            if (typeof content === "string") {
              return content.includes("Do a blocking task");
            }
            if (Array.isArray(content)) {
              return content.some(
                (block) =>
                  block.type === "text" &&
                  block.text.includes("Do a blocking task"),
              );
            }
            return false;
          });
        },
        message: "waiting for subagent stream with blocking task",
      });

      // Subagent does its work and yields
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

      // Now wait for the parent to receive the tool result with the yield message
      const parentToolResult =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Found the answer: 42",
        );

      // Verify the parent got the yield result using the helper
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
      expect(content).toContain("completed");
    });
  });
});
