import { TMP_DIR, withDriver } from "../test/preamble.ts";
import { LOGO } from "./thread.ts";
import { type ToolRequestId } from "../tools/toolManager.ts";
import { describe, expect, it } from "vitest";
import type { UnresolvedFilePath } from "../utils/files.ts";
import { type Input as CompactThreadInput } from "../tools/compact-thread";

describe("node/chat/thread.spec.ts", () => {
  it("chat render and a few updates", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("Can you run a simple command for me?");
      await driver.send();

      await driver.mockAnthropic.awaitPendingRequest();
      const toolRequestId = "test-bash-command" as ToolRequestId;

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "Sure, let me run a simple bash command for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "bash_command",
              input: { command: "echo 'Hello from bash!'" },
            },
          },
        ],
      });

      // Check that the buffer contains the expected content during tool execution
      await driver.assertDisplayBufferContains(
        "Can you run a simple command for me?",
      );
      await driver.assertDisplayBufferContains(
        "Sure, let me run a simple bash command for you.",
      );

      // After the tool executes
      await driver.assertDisplayBufferContains("Hello from bash!");
    });
  });

  it("chat clear", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("Can you look at my list of buffers?");
      await driver.send();

      await driver.mockAnthropic.awaitPendingRequest();

      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "Sure, let me use the list_buffers tool.",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContains(
        "Can you look at my list of buffers?",
      );
      await driver.assertDisplayBufferContains(
        "Sure, let me use the list_buffers tool.",
      );

      await driver.clear();
      await driver.assertDisplayBufferContains(LOGO.split("\n")[0]);
    });
  });

  it("getMessages correctly interleaves tool requests and responses", async () => {
    await withDriver({}, async (driver) => {
      // Create a more complex conversation with multiple tool uses
      await driver.showSidebar();
      await driver.inputMagentaText("Can you help me with my code?");
      await driver.send();

      await driver.mockAnthropic.awaitPendingRequest();

      const toolRequestId1 = "tool-1" as ToolRequestId;
      const toolRequestId2 = "tool-2" as ToolRequestId;

      // First response with bash_command tool use
      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "I'll help you. Let me check your project first.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId1,
              toolName: "bash_command",
              input: { command: "echo 'Project files summary'" },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("Project files summary");

      await driver.mockAnthropic.awaitPendingRequest();
      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "Now let me check your project structure.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId2,
              toolName: "bash_command",
              input: { command: "echo 'Project structure summary'" },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("Project structure summary");

      // Final part of the assistant's response
      await driver.mockAnthropic.awaitPendingRequest();
      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "Based on these results, I can help you.",
        toolRequests: [],
      });

      // Verify all parts of the conversation are present
      await driver.assertDisplayBufferContains("Can you help me with my code?");
      await driver.assertDisplayBufferContains(
        "I'll help you. Let me check your project first.",
      );
      await driver.assertDisplayBufferContains(
        "Now let me check your project structure.",
      );
      await driver.assertDisplayBufferContains(
        "Based on these results, I can help you.",
      );

      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      expect(messages.length).toBe(6);
      expect(
        messages.flatMap((m) => m.content.map((b) => m.role + ":" + b.type)),
      ).toEqual([
        "user:text",
        "assistant:text",
        "assistant:tool_use",
        "user:tool_result",
        "assistant:text",
        "assistant:tool_use",
        "user:tool_result",
        "assistant:text",
      ]);
    });
  });

  it("handles errors during streaming response", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("Test error handling during response");
      await driver.send();

      await driver.mockAnthropic.awaitPendingRequest();

      // Simulate an error during streaming
      const errorMessage = "Simulated error during streaming";
      await driver.mockAnthropic.respondWithError(new Error(errorMessage));

      // Verify the error is handled and displayed to the user
      await driver.assertDisplayBufferContains(
        "Test error handling during response",
      );

      // Verify error message is displayed in the UI
      await driver.assertDisplayBufferContains("Error");
      await driver.assertDisplayBufferContains(errorMessage);
    });
  });

  it("compacts a thread with multiple messages into a new thread", async () => {
    await withDriver({}, async (driver) => {
      // 1. Open the sidebar
      await driver.showSidebar();

      // 2. Create a thread with multiple messages and tool uses
      await driver.inputMagentaText("What is the capital of France?");
      await driver.send();

      // Wait for the request and respond
      await driver.mockAnthropic.awaitPendingRequest("initial request");
      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "The capital of France is Paris.",
        toolRequests: [],
      });

      // Add a second message with a tool use
      await driver.inputMagentaText("What about Germany?");
      await driver.send();

      // Wait for the request and respond with a tool use (bash_command)
      await driver.mockAnthropic.awaitPendingRequest("followup request");
      const firstBashToolId = "first-bash-tool" as ToolRequestId;
      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "Let me check if I can find some information about Germany in your system.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: firstBashToolId,
              toolName: "bash_command",
              input: { command: "echo 'Information about Germany'" },
            },
          },
        ],
      });

      await driver.mockAnthropic.awaitPendingRequest(
        "first-bash auto-response",
      );
      const secondBashToolId = "second-bash-tool" as ToolRequestId;
      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "Let me check for more details about European countries.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: secondBashToolId,
              toolName: "bash_command",
              input: { command: "echo 'European countries information'" },
            },
          },
        ],
      });

      await driver.mockAnthropic.awaitPendingRequest(
        "second-bash auto-response",
      );
      const bashToolId = "bash-tool" as ToolRequestId;
      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "test bash tool",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: bashToolId,
              toolName: "bash_command",
              input: {
                command: "echo test",
              },
            },
          },
        ],
      });

      await driver.mockAnthropic.awaitPendingRequest("bash auto-response");
      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "The capital of Germany is Berlin.",
        toolRequests: [],
      });

      // 3. Initiate thread compaction
      await driver.inputMagentaText("@compact Tell me about Italy");
      await driver.send();

      // 4. Verify the forceToolUse request for compact_thread was made
      const request =
        await driver.mockAnthropic.awaitPendingForceToolUseRequest(
          "compact request",
        );

      expect(request.messages).toMatchSnapshot("forced-tool-request-messages");

      const contextFiles = [
        `${TMP_DIR}/poem.txt` as unknown as UnresolvedFilePath,
        `${TMP_DIR}/poem2.txt` as unknown as UnresolvedFilePath,
      ];

      const compactInput: CompactThreadInput = {
        contextFiles,
        summary:
          "We discussed European capitals (France: Paris, Germany: Berlin) and examined your project structure, which contains TypeScript files.",
      };

      const toolRequestId = "compact-thread-tool" as ToolRequestId;
      await driver.mockAnthropic.respondToForceToolUse({
        stopReason: "end_turn",
        toolRequest: {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "compact_thread",
            input: compactInput,
          },
        },
      });

      // 6. Verify a new thread was created and is active
      // Check that the new thread contains the summary and the latest message
      await driver.assertDisplayBufferContains(
        "We discussed European capitals",
      );
      await driver.assertDisplayBufferContains("Tell me about Italy");

      // 7. Respond to the new thread's initial message
      await driver.mockAnthropic.awaitPendingRequest();
      await driver.mockAnthropic.respond({
        stopReason: "end_turn",
        text: "Italy's capital is Rome. It's known for its rich history, art, and cuisine.",
        toolRequests: [],
      });

      // 8. Verify the complete conversation flow
      await driver.assertDisplayBufferContains("Tell me about Italy");
      await driver.assertDisplayBufferContains("Italy's capital is Rome");

      // 9. Get the current thread and check its state
      const thread = driver.magenta.chat.getActiveThread();

      // Check that the first message contains the context from compaction
      expect(thread.state.messages[0].state.content).toBeDefined();

      // The original thread should have been replaced
      // Since we can't directly check the buffer doesn't contain text, assert it does contain
      // text we expect, which would replace the text from the old thread
      await driver.assertDisplayBufferContains("Tell me about Italy");

      // Get the context manager from the thread directly
      const contextManager = thread.contextManager;

      // Verify that contextManager.files contains the two poem files we added
      const files = contextManager.files;
      expect(Object.keys(files).length).toBe(2);

      // 10. Verify the thread's message structure after compaction
      const messages = thread.getMessages();

      expect(messages).toMatchSnapshot("compacted-thread-messages");

      // First message should be the summary (context), second should be the user's question about Italy
      expect(messages.length).toBe(2);

      // Verify we captured expected message structure (user->assistant)
      expect(
        messages.flatMap((m) => m.content.map((b) => m.role + ":" + b.type)),
      ).toEqual([
        "user:text", // The compacted thread summary (context)
        "user:text", // The user question about Italy
        "assistant:text", // The assistant response about Rome
      ]);
    });
  });
});
