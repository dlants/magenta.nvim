import { withDriver } from "../test/preamble.ts";
import { LOGO } from "./thread.ts";
import { type ToolRequestId } from "../tools/toolManager.ts";
import { expect, it } from "vitest";
import type { UnresolvedFilePath } from "../utils/files.ts";
import { type Input as ForkThreadInput } from "../tools/fork-thread.ts";
import type { ToolName } from "../tools/types.ts";
import { delay, pollUntil } from "../utils/async.ts";
import { getcwd } from "../nvim/nvim.ts";
import { $, within } from "zx";
import type { WebSearchResultBlock } from "@anthropic-ai/sdk/resources.mjs";
import fs from "node:fs";
import { resolveFilePath } from "../utils/files.ts";
import lodash from "lodash";

/** Replace dynamic thread IDs and timing info in messages with a placeholder for stable snapshots */
function sanitizeMessagesForSnapshot<T>(messages: T): T {
  let json = JSON.stringify(messages);
  // Replace thread IDs like 019bab33-8c7c-76a9-bc7c-9f94103502c8 with placeholder
  json = json.replace(
    /\/tmp\/magenta\/threads\/[a-f0-9-]+\//g,
    "/tmp/magenta/threads/<thread-id>/",
  );
  // Replace timing info like "exit code 0 (16ms)" with stable placeholder
  json = json.replace(/\((\d+)ms\)/g, "(<timing>ms)");
  return JSON.parse(json) as T;
}

it("chat render and a few updates", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Can you run a simple command for me?");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();
    const toolRequestId = "test-bash-command" as ToolRequestId;

    stream.respond({
      stopReason: "tool_use",
      text: "Sure, let me run a simple bash command for you.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "bash_command" as ToolName,
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

it("new-thread creates fresh thread", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Can you look at my list of buffers?");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();

    stream.respond({
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

    await driver.magenta.command("new-thread");
    await driver.assertDisplayBufferContains(LOGO.split("\n")[0]);
  });
});

it("getMessages correctly interleaves tool requests and responses", async () => {
  await withDriver({}, async (driver) => {
    // Create a more complex conversation with multiple tool uses
    await driver.showSidebar();
    await driver.inputMagentaText("Can you help me with my code?");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();

    const toolRequestId1 = "tool-1" as ToolRequestId;
    const toolRequestId2 = "tool-2" as ToolRequestId;

    // First response with bash_command tool use
    request1.respond({
      stopReason: "tool_use",
      text: "I'll help you. Let me check your project first.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId1,
            toolName: "bash_command" as ToolName,
            input: { command: "echo 'Project files summary'" },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains("Project files summary");

    const request2 = await driver.mockAnthropic.awaitPendingStream();
    request2.respond({
      stopReason: "tool_use",
      text: "Now let me check your project structure.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId2,
            toolName: "bash_command" as ToolName,
            input: { command: "echo 'Project structure summary'" },
          },
        },
      ],
    });

    await driver.assertDisplayBufferContains("Project structure summary");

    // Final part of the assistant's response
    const request3 = await driver.mockAnthropic.awaitPendingStream();
    request3.respond({
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

    expect(messages.length).toBe(8);
    expect(
      messages.flatMap((m) => m.content.map((b) => m.role + ":" + b.type)),
    ).toEqual([
      "user:text",
      "user:system_reminder",
      "assistant:text",
      "assistant:tool_use",
      "user:tool_result",
      "user:system_reminder", // system reminder after first tool response
      "assistant:text",
      "assistant:tool_use",
      "user:tool_result",
      "user:system_reminder", // system reminder after second tool response
      "assistant:text",
    ]);
  });
});

it("handles errors during streaming response", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Test error handling during response");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();

    // Simulate an error during streaming
    const errorMessage = "Simulated error during streaming";
    stream.respondWithError(new Error(errorMessage));

    // Verify the error is handled and displayed to the user
    await driver.assertDisplayBufferContains(
      "Test error handling during response",
    );

    // Verify error message is displayed in the UI
    await driver.assertDisplayBufferContains("Error");
    await driver.assertDisplayBufferContains(errorMessage);
  });
});

it("forks a thread with multiple messages into a new thread", async () => {
  await withDriver({}, async (driver) => {
    // 1. Open the sidebar
    await driver.showSidebar();

    // 2. Create a thread with multiple messages and tool uses
    await driver.inputMagentaText("What is the capital of France?");
    await driver.send();

    // Wait for the request and respond
    const request1 = await driver.mockAnthropic.awaitPendingStream({
      message: "initial request",
    });
    request1.respond({
      stopReason: "end_turn",
      text: "The capital of France is Paris.",
      toolRequests: [],
    });

    // Add a second message with a tool use
    await driver.inputMagentaText("What about Germany?");
    await driver.send();
    // Wait for the request and respond with a tool use (bash_command)
    const request2 = await driver.mockAnthropic.awaitPendingStream({
      message: "followup request",
    });
    const firstBashToolId = "first-bash-tool" as ToolRequestId;
    request2.respond({
      stopReason: "tool_use",
      text: "Let me check if I can find some information about Germany in your system.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: firstBashToolId,
            toolName: "bash_command" as ToolName,
            input: { command: "echo 'Information about Germany'" },
          },
        },
      ],
    });

    const request3 = await driver.mockAnthropic.awaitPendingStream({
      message: "first-bash auto-response",
    });
    const secondBashToolId = "second-bash-tool" as ToolRequestId;
    request3.respond({
      stopReason: "tool_use",
      text: "Let me check for more details about European countries.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: secondBashToolId,
            toolName: "bash_command" as ToolName,
            input: { command: "echo 'European countries information'" },
          },
        },
      ],
    });

    const request4 = await driver.mockAnthropic.awaitPendingStream({
      message: "second-bash auto-response",
    });
    const bashToolId = "bash-tool" as ToolRequestId;
    request4.respond({
      stopReason: "tool_use",
      text: "test bash tool",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: bashToolId,
            toolName: "bash_command" as ToolName,
            input: {
              command: "echo test",
            },
          },
        },
      ],
    });

    const request5 = await driver.mockAnthropic.awaitPendingStream({
      message: "bash auto-response",
    });
    request5.respond({
      stopReason: "end_turn",
      text: "The capital of Germany is Berlin.",
      toolRequests: [],
    });

    await driver.inputMagentaText("@fork Tell me about Italy");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();
    expect(sanitizeMessagesForSnapshot(stream.messages)).toMatchSnapshot(
      "fork-tool-request-messages",
    );

    const forkInput: ForkThreadInput = {
      contextFiles: ["poem.txt", "poem2.txt"] as UnresolvedFilePath[],
      summary:
        "We discussed European capitals (France: Paris, Germany: Berlin) and examined your project structure, which contains TypeScript files.",
    };

    const toolRequestId = "fork-thread-tool" as ToolRequestId;
    stream.respond({
      stopReason: "tool_use",
      text: "",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "fork_thread" as ToolName,
            input: forkInput,
          },
        },
      ],
    });

    // 6. Verify a new thread was created and is active
    // Check that the new thread contains the summary and the latest message
    await driver.assertDisplayBufferContains("We discussed European capitals");
    await driver.assertDisplayBufferContains("Tell me about Italy");

    // 7. Respond to the new thread's initial message
    const request6 = await driver.mockAnthropic.awaitPendingStream();
    request6.respond({
      stopReason: "end_turn",
      text: "Italy's capital is Rome. It's known for its rich history, art, and cuisine.",
      toolRequests: [],
    });

    // 8. Verify the complete conversation flow
    await driver.assertDisplayBufferContains("Tell me about Italy");
    await driver.assertDisplayBufferContains("Italy's capital is Rome");

    // 9. Get the current thread and check its state
    const thread = driver.magenta.chat.getActiveThread();
    {
      const messages = thread.getProviderMessages();

      expect(messages[0].content).toBeDefined();
    }

    // The original thread should have been replaced
    // Since we can't directly check the buffer doesn't contain text, assert it does contain
    // text we expect, which would replace the text from the old thread
    await driver.assertDisplayBufferContains("Tell me about Italy");

    // Get the context manager from the thread directly
    const contextManager = thread.contextManager;

    // Verify that contextManager.files contains the two poem files we added
    const files = contextManager.files;
    expect(Object.keys(files).length).toBe(2);

    {
      const messages = thread.getMessages();

      expect(messages).toMatchSnapshot("forked-thread-messages");
    }
  });
});

it(
  "processes @diag keyword to include diagnostics in message",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // Create a file with syntax errors to generate diagnostics
      await driver.editFile("test.ts");
      await driver.showSidebar();

      // Wait for diagnostics to be available
      await pollUntil(
        async () => {
          const diagnostics = (await driver.nvim.call("nvim_exec_lua", [
            `return vim.diagnostic.get(nil)`,
            [],
          ])) as unknown[];

          if (diagnostics.length === 0) {
            throw new Error("No diagnostics available yet");
          }
        },
        { timeout: 5000 },
      );

      // Send a message with @diag keyword
      await driver.inputMagentaText("Help me fix this issue @diag");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I can see the diagnostics you've provided. Let me help you fix the issue.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains("Help me fix this issue @diag");

      // Verify the diagnostics are appended as a separate content block
      await driver.assertDisplayBufferContains("Current diagnostics:");
      await driver.assertDisplayBufferContains(
        "Property 'd' does not exist on type",
      );
      await driver.assertDisplayBufferContains("test.ts");

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have three content blocks: original text + diagnostics + system_reminder
      expect(messages[0].content.length).toBe(3);
      const content0 = messages[0].content[0];
      expect(content0.type).toBe("text");
      expect(
        (content0 as Extract<typeof content0, { type: "text" }>).text,
      ).toBe("Help me fix this issue @diag");
      const content1 = messages[0].content[1];
      expect(content1.type).toBe("text");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Current diagnostics:");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Property 'd' does not exist on type");
    });
  },
);

it(
  "processes @diagnostics keyword to include diagnostics in message",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // Create a file with syntax errors to generate diagnostics
      await driver.editFile("test.ts");
      await driver.showSidebar();

      // Wait for diagnostics to be available
      await pollUntil(
        async () => {
          const diagnostics = (await driver.nvim.call("nvim_exec_lua", [
            `return vim.diagnostic.get(nil)`,
            [],
          ])) as unknown[];

          if (diagnostics.length === 0) {
            throw new Error("No diagnostics available yet");
          }
        },
        { timeout: 5000 },
      );

      // Send a message with @diagnostics keyword
      await driver.inputMagentaText("Check these @diagnostics please");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I can see the diagnostics. Let me analyze them for you.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains(
        "Check these @diagnostics please",
      );

      // Verify the diagnostics are appended as a separate content block
      await driver.assertDisplayBufferContains("Current diagnostics:");
      await driver.assertDisplayBufferContains(
        "Property 'd' does not exist on type",
      );

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have three content blocks: original text + diagnostics + system_reminder
      expect(messages[0].content.length).toBe(3);
      const content0 = messages[0].content[0];
      expect(content0.type).toBe("text");
      expect(
        (content0 as Extract<typeof content0, { type: "text" }>).text,
      ).toBe("Check these @diagnostics please");
      const content1 = messages[0].content[1];
      expect(content1.type).toBe("text");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Current diagnostics:");
    });
  },
);
it(
  "processes @qf keyword to include quickfix list in message",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // Create some test quickfix entries
      await driver.nvim.call("nvim_command", [
        "call setqflist([" +
          "{'filename': 'test1.ts', 'lnum': 10, 'col': 5, 'text': 'Error: undefined variable'}," +
          "{'filename': 'test2.js', 'lnum': 25, 'col': 12, 'text': 'Warning: unused import'}" +
          "])",
      ]);

      await driver.showSidebar();

      // Send a message with @qf keyword
      await driver.inputMagentaText("Help me fix these issues @qf");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I can see the quickfix list you've provided. Let me help you fix these issues.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains("Help me fix these issues @qf");

      // Verify the quickfix list is appended as a separate content block
      await driver.assertDisplayBufferContains("Current quickfix list:");
      await driver.assertDisplayBufferContains("Error: undefined variable");
      await driver.assertDisplayBufferContains("Warning: unused import");
      await driver.assertDisplayBufferContains("test1.ts:10:5");
      await driver.assertDisplayBufferContains("test2.js:25:12");

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have three content blocks: original text + quickfix list + system_reminder
      expect(messages[0].content.length).toBe(3);
      const content0 = messages[0].content[0];
      expect(content0.type).toBe("text");
      expect(
        (content0 as Extract<typeof content0, { type: "text" }>).text,
      ).toBe("Help me fix these issues @qf");
      const content1 = messages[0].content[1];
      expect(content1.type).toBe("text");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Current quickfix list:");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Error: undefined variable");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Warning: unused import");
    });
  },
);

it(
  "processes @quickfix keyword to include quickfix list in message",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // Create some test quickfix entries
      await driver.nvim.call("nvim_command", [
        "call setqflist([" +
          "{'filename': 'error.py', 'lnum': 42, 'col': 1, 'text': 'SyntaxError: invalid syntax'}," +
          "{'filename': 'warning.js', 'lnum': 15, 'col': 8, 'text': 'Unused variable'}" +
          "])",
      ]);

      await driver.showSidebar();

      // Send a message with @quickfix keyword
      await driver.inputMagentaText("Check these @quickfix entries");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I can see the quickfix entries. Let me analyze them for you.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains("Check these @quickfix entries");

      // Verify the quickfix list is appended as a separate content block
      await driver.assertDisplayBufferContains("Current quickfix list:");
      await driver.assertDisplayBufferContains("SyntaxError: invalid syntax");
      await driver.assertDisplayBufferContains("Unused variable");
      await driver.assertDisplayBufferContains("error.py:42:1");
      await driver.assertDisplayBufferContains("warning.js:15:8");

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have three content blocks: original text + quickfix list + system_reminder
      expect(messages[0].content.length).toBe(3);
      const content0 = messages[0].content[0];
      expect(content0.type).toBe("text");
      expect(
        (content0 as Extract<typeof content0, { type: "text" }>).text,
      ).toBe("Check these @quickfix entries");
      const content1 = messages[0].content[1];
      expect(content1.type).toBe("text");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Current quickfix list:");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("SyntaxError: invalid syntax");
    });
  },
);

it(
  "handles empty quickfix list with @qf command",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // Clear quickfix list
      await driver.nvim.call("nvim_command", ["call setqflist([])"]);

      await driver.showSidebar();

      // Send a message with @qf keyword
      await driver.inputMagentaText("Any issues to fix? @qf");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I can see the quickfix list is empty. No issues to fix right now!",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains("Any issues to fix? @qf");

      // Verify the empty quickfix list is handled properly
      await driver.assertDisplayBufferContains("Current quickfix list:");

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have three content blocks: original text + empty quickfix list + system_reminder
      expect(messages[0].content.length).toBe(3);
      const content1 = messages[0].content[1];
      expect(content1.type).toBe("text");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toBe("Current quickfix list:\n");
    });
  },
);

it(
  "processes @buf keyword to include buffers list in message",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // Create some test buffers
      await driver.editFile("poem.txt");
      await driver.editFile("poem2.txt");
      await driver.showSidebar();

      // Send a message with @buf keyword
      await driver.inputMagentaText("Help me organize my files @buf");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I can see the buffers you have open. Let me help you organize them.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains(
        "Help me organize my files @buf",
      );

      // Verify the buffers list is appended as a separate content block
      await driver.assertDisplayBufferContains("Current buffers list:");
      await driver.assertDisplayBufferContains("poem.txt");
      await driver.assertDisplayBufferContains("active poem2.txt");

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have three content blocks: original text + buffers list + system_reminder
      expect(messages[0].content.length).toBe(3);
      const content0 = messages[0].content[0];
      expect(content0.type).toBe("text");
      expect(
        (content0 as Extract<typeof content0, { type: "text" }>).text,
      ).toBe("Help me organize my files @buf");
      const content1 = messages[0].content[1];
      expect(content1.type).toBe("text");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Current buffers list:");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("poem.txt");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("active poem2.txt");
    });
  },
);

it(
  "processes @buffers keyword to include buffers list in message",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // Create some test buffers
      await driver.editFile("poem.txt");
      await driver.editFile("poem2.txt");
      await driver.showSidebar();

      // Send a message with @buffers keyword
      await driver.inputMagentaText("Show me my current @buffers");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I can see your current buffers. Here's what you have open.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains("Show me my current @buffers");

      // Verify the buffers list is appended as a separate content block
      await driver.assertDisplayBufferContains("Current buffers list:");
      await driver.assertDisplayBufferContains("poem.txt");
      await driver.assertDisplayBufferContains("active poem2.txt");

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have three content blocks: original text + buffers list + system_reminder
      expect(messages[0].content.length).toBe(3);
      const content0 = messages[0].content[0];
      expect(content0.type).toBe("text");
      expect(
        (content0 as Extract<typeof content0, { type: "text" }>).text,
      ).toBe("Show me my current @buffers");
      const content1 = messages[0].content[1];
      expect(content1.type).toBe("text");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Current buffers list:");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("poem.txt");
    });
  },
);

it(
  "handles empty buffers list with @buf command",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Send a message with @buf keyword
      await driver.inputMagentaText("What files do I have open? @buf");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I can see your current buffers. It looks like you have minimal files open.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains(
        "What files do I have open? @buf",
      );

      // Verify the buffers list is handled properly
      await driver.assertDisplayBufferContains("Current buffers list:");

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have three content blocks: original text + buffers list + system_reminder
      expect(messages[0].content.length).toBe(3);
      const content1 = messages[0].content[1];
      expect(content1.type).toBe("text");
      expect(
        (content1 as Extract<typeof content1, { type: "text" }>).text,
      ).toContain("Current buffers list:");
    });
  },
);

it(
  "processes @diff command to include git diff in message",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // First, initialize git and commit the file so we can create a diff
      const cwd = await getcwd(driver.nvim);
      await within(async () => {
        $.cwd = cwd;
        // stage the file
        await $`git add poem.txt`;
        // add an unstaged change
        await $`echo 'modified content' >> poem.txt`;
      });

      await driver.showSidebar();

      // Send a message with @diff command
      await driver.inputMagentaText("Show me changes in @diff:poem.txt");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();

      // Check that the request messages contain the git diff
      const userMessage = stream.messages.find((msg) => msg.role === "user");
      expect(userMessage).toBeDefined();
      const userContent = userMessage!.content;
      expect(Array.isArray(userContent)).toBe(true);
      if (!Array.isArray(userContent)) throw new Error("Expected array");
      expect(userContent.length).toBeGreaterThan(1);

      // Find the diff content block in the request
      const diffContent = userContent.find(
        (content) =>
          content.type === "text" &&
          content.text.includes("Git diff for `poem.txt`:") &&
          content.text.includes("modified content"),
      );
      expect(diffContent).toBeDefined();

      stream.respond({
        stopReason: "end_turn",
        text: "I can see the git diff you've provided. Let me analyze the changes.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains(
        "Show me changes in @diff:poem.txt",
      );

      // Verify git diff content is included
      await driver.assertDisplayBufferContains("Git diff for `poem.txt`:");
      await driver.assertDisplayBufferContains("modified content");
    });
  },
);

it(
  "processes @staged command to include staged diff in message",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      // First, initialize git and commit the file so we can create a staged diff
      const cwd = await getcwd(driver.nvim);
      await within(async () => {
        $.cwd = cwd;
        await $`echo 'staged content' >> poem2.txt`;
        await $`git add poem2.txt`;
      });

      await driver.showSidebar();

      // Send a message with @staged command
      await driver.inputMagentaText("Review staged changes @staged:poem2.txt");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();

      // Check that the request messages contain the staged diff
      const userMessage = stream.messages.find((msg) => msg.role === "user");
      expect(userMessage).toBeDefined();
      const userContent = userMessage!.content;
      expect(Array.isArray(userContent)).toBe(true);
      if (!Array.isArray(userContent)) throw new Error("Expected array");
      expect(userContent.length).toBeGreaterThan(1);

      // Find the staged diff content block in the request
      const stagedContent = userContent.find(
        (content) =>
          content.type === "text" &&
          content.text.includes("Staged diff for `poem2.txt`:") &&
          content.text.includes("staged content"),
      );
      expect(stagedContent).toBeDefined();

      stream.respond({
        stopReason: "end_turn",
        text: "I can see the staged changes you've provided. Let me review them.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains(
        "Review staged changes @staged:poem2.txt",
      );

      // Verify staged diff content is included
      await driver.assertDisplayBufferContains("Staged diff for `poem2.txt`:");
      await driver.assertDisplayBufferContains("staged content");
    });
  },
);

it("handles @file commands", { timeout: 10000 }, async () => {
  await withDriver({}, async (driver) => {
    // Create test files
    await driver.editFile("poem.txt");
    await driver.editFile("poem2.txt");
    await driver.showSidebar();

    // Send a message with multiple @file commands
    await driver.inputMagentaText(
      "Compare these files @file:poem.txt and @file:poem2.txt",
    );
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();

    // Check that the request messages contain context updates for the added files
    const userMessage = stream.messages.find((msg) => msg.role === "user");
    expect(userMessage).toBeDefined();
    const userContent = userMessage!.content;
    expect(Array.isArray(userContent)).toBe(true);
    if (!Array.isArray(userContent)) throw new Error("Expected array");

    // Look for context updates in the request messages - they should appear as text content
    // containing the file contents
    const contextContent = userContent.find(
      (content) =>
        content.type === "text" &&
        (content.text.includes("poem.txt") ||
          content.text.includes("poem2.txt")),
    );
    expect(contextContent).toBeDefined();

    stream.respond({
      stopReason: "end_turn",
      text: "I can see both files you've added to context. Let me compare them.",
      toolRequests: [],
    });

    // Verify the original message is displayed
    await driver.assertDisplayBufferContains(
      "Compare these files @file:poem.txt and @file:poem2.txt",
    );

    // Verify both files were added to context manager
    const thread = driver.magenta.chat.getActiveThread();
    const contextManager = thread.contextManager;
    const files = contextManager.files;

    // Check that both files are in the context
    const hasPoem1 = Object.keys(files).some((path) =>
      path.includes("poem.txt"),
    );
    const hasPoem2 = Object.keys(files).some((path) =>
      path.includes("poem2.txt"),
    );
    expect(hasPoem1).toBe(true);
    expect(hasPoem2).toBe(true);
  });
});

it(
  "handles @file command with non-existent file",
  { timeout: 10000 },
  async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Send a message with @file command for non-existent file
      await driver.inputMagentaText("Help with @file:nonexistent.txt");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "end_turn",
        text: "I see there was an error adding that file to context.",
        toolRequests: [],
      });

      // Verify the original message is displayed
      await driver.assertDisplayBufferContains(
        "Help with @file:nonexistent.txt",
      );

      // Verify error message is included
      await driver.assertDisplayBufferContains("Error adding file to context");
      await driver.assertDisplayBufferContains("nonexistent.txt");

      // Check the thread message structure
      const thread = driver.magenta.chat.getActiveThread();
      const messages = thread.getMessages();

      // Should have user message and assistant response
      expect(messages.length).toBe(2);

      // The user message should have multiple content blocks including error
      expect(messages[0].content.length).toBeGreaterThan(1);

      // The user message should have multiple content blocks including error
      expect(messages[0].content.length).toBeGreaterThan(1);

      // Find the error content block
      const errorContent = messages[0].content.find(
        (content) =>
          content.type === "text" &&
          content.text.includes("Error adding file to context"),
      );
      expect(errorContent).toBeDefined();
    });
  },
);

it("display multiple edits to the same file, and edit details", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(`Update the poem in the file poem.txt`);
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();
    stream.respond({
      stopReason: "tool_use",
      text: "ok, I will try to rewrite the poem in that file",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "id1" as ToolRequestId,
            toolName: "replace" as ToolName,
            input: {
              filePath: "poem.txt" as UnresolvedFilePath,
              find: `Moonlight whispers through the trees,
Silver shadows dance with ease.
Stars above like diamonds bright,
Paint their stories in the night.`,
              replace: `Replace 1
Replace 2`,
            },
          },
        },
      ],
    });
    await driver.assertDisplayBufferContains(`\
# user:
Update the poem in the file poem.txt`);

    await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file
✏️✅ Replace [[ -4 / +2 ]] in \`poem.txt\`
\`\`\`diff
-Moonlight whispers through the trees,
-Silver shadows dance with ease.
-Stars above like diamonds bright,
-Paint their stories in the night.
\\ No newline at end of file
+Replace 1
+Replace 2
\\ No newline at end of file

\`\`\``);

    await driver.assertDisplayBufferContains(`\
Edits:
- \`poem.txt\` (1 edits). [± diff snapshot]`);

    const reviewPos = await driver.assertDisplayBufferContains("diff snapshot");
    await driver.triggerDisplayBufferKey(reviewPos, "<CR>");

    await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file
✏️✅ Replace [[ -4 / +2 ]] in \`poem.txt\``);

    // Go back to main view
    await driver.triggerDisplayBufferKey(reviewPos, "<CR>");

    await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file
✏️✅ Replace [[ -4 / +2 ]] in \`poem.txt\``);
  });
});

it("displays deleted context updates correctly", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Create a temporary file for testing
    const cwd = await getcwd(driver.nvim);
    const tempFilePath = resolveFilePath(
      cwd,
      "temp-delete-test.txt" as UnresolvedFilePath,
    );
    const tempContent = "temporary file content\nfor testing deletion";
    await fs.promises.writeFile(tempFilePath, tempContent);

    // Add file to context
    await driver.addContextFiles("temp-delete-test.txt");

    // Verify file is in context
    await driver.assertDisplayBufferContains(`\
# context:
- \`temp-delete-test.txt\``);

    // Delete the file from disk
    await fs.promises.unlink(tempFilePath);

    // Send a message to trigger context update
    await driver.inputMagentaText("What happened to the file?");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();

    // Check that the request contains the file deletion update
    stream.messages.find(
      (msg) =>
        msg.role === "user" &&
        typeof msg.content === "object" &&
        lodash.some(
          msg.content,
          (b) =>
            b.type === "text" &&
            b.text.includes("temp-delete-test.txt") &&
            b.text.includes("This file has been deleted"),
        ),
    );

    stream.respond({
      stopReason: "end_turn",
      text: "I can see the file has been deleted from context.",
      toolRequests: [],
    });

    // Verify the display shows the deletion indicator - check pieces separately
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains("Context Updates:");
    await driver.assertDisplayBufferContains(
      "`temp-delete-test.txt` [ deleted ]",
    );
    await driver.assertDisplayBufferContains("What happened to the file?");
    await driver.assertDisplayBufferContains("# assistant:");
    await driver.assertDisplayBufferContains(
      "I can see the file has been deleted from context.",
    );
  });
});

it("handles web search results and citations together", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(
      `Compare TypeScript and JavaScript for large projects`,
    );
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();

    // Stream server tool use (web search)
    stream.streamServerToolUse("search_1", "web_search", {
      query: "TypeScript vs JavaScript large projects",
    });

    // Stream web search result
    stream.streamWebSearchToolResult("search_1", [
      {
        type: "web_search_result",
        title: "TypeScript vs JavaScript: Which Is Better for Your Project?",
        url: "https://example.com/typescript-vs-javascript",
        encrypted_content: "",
        page_age: "3 months ago",
      },
    ] as WebSearchResultBlock[]);

    // Stream text content
    stream.streamText(
      "TypeScript offers significant advantages for large projects compared to JavaScript.",
    );

    // Finish the response
    stream.finishResponse("end_turn");

    // Verify content pieces separately to allow for system reminder
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains(
      "Compare TypeScript and JavaScript for large projects",
    );
    await driver.assertDisplayBufferContains("# assistant:");
    await driver.assertDisplayBufferContains(
      "🔍 Searching TypeScript vs JavaScript large projects...",
    );
    await driver.assertDisplayBufferContains("🌐 Search results");
    await driver.assertDisplayBufferContains(
      "[TypeScript vs JavaScript: Which Is Better for Your Project?]",
    );
    await driver.assertDisplayBufferContains(
      "TypeScript offers significant advantages for large projects compared to JavaScript.",
    );
    await driver.assertDisplayBufferContains("Stopped (end_turn)");
  });
});

it("handles thinking and redacted thinking blocks", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText(
      "What should I consider when designing a database schema?",
    );
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();

    // Stream thinking block
    stream.streamThinking("abc\ndef\nghi");

    // Stream redacted thinking block
    stream.streamRedactedThinking(
      "This thinking contains sensitive information that has been redacted.",
    );

    stream.finishResponse("end_turn");

    // Assert initial collapsed state of thinking block - check pieces separately
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains(
      "What should I consider when designing a database schema?",
    );
    await driver.assertDisplayBufferContains("# assistant:");
    await driver.assertDisplayBufferContains("💭 [Thinking]");
    await driver.assertDisplayBufferContains("💭 [Redacted Thinking]");

    // Test expanding the thinking block
    const thinkingPos =
      await driver.assertDisplayBufferContains("💭 [Thinking]");
    await driver.triggerDisplayBufferKey(thinkingPos, "<CR>");

    // Verify expanded thinking block - check pieces separately
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains(
      "What should I consider when designing a database schema?",
    );
    await driver.assertDisplayBufferContains("# assistant:");
    await driver.assertDisplayBufferContains("💭 [Thinking]");
    await driver.assertDisplayBufferContains("abc");
    await driver.assertDisplayBufferContains("def");
    await driver.assertDisplayBufferContains("ghi");
    await driver.assertDisplayBufferContains("💭 [Redacted Thinking]");

    // Test collapsing the thinking block
    const expandedThinkingPos =
      await driver.assertDisplayBufferContains("💭 [Thinking]");
    await driver.triggerDisplayBufferKey(expandedThinkingPos, "<CR>");

    // Verify collapsed thinking block again - check pieces separately
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains(
      "What should I consider when designing a database schema?",
    );
    await driver.assertDisplayBufferContains("# assistant:");
    await driver.assertDisplayBufferContains("💭 [Thinking]");
    await driver.assertDisplayBufferContains("💭 [Redacted Thinking]");

    // Send a followup message to test that thinking blocks are included in context
    await driver.inputMagentaText("Can you elaborate on normalization?");
    await driver.send();

    const followupStream = await driver.mockAnthropic.awaitPendingStream();

    // Verify that the followup request includes both thinking blocks in messages
    const assistantMessage = followupStream.messages.find(
      (msg) => msg.role === "assistant",
    );
    expect(assistantMessage).toBeTruthy();
    const assistantContent = assistantMessage!.content;
    expect(Array.isArray(assistantContent)).toBe(true);
    if (!Array.isArray(assistantContent)) throw new Error("Expected array");
    expect(assistantContent).toHaveLength(2);

    // Check thinking block is included with full content
    const thinkingContent = assistantContent[0];
    expect(thinkingContent.type).toBe("thinking");
    expect(
      (thinkingContent as Extract<typeof thinkingContent, { type: "thinking" }>)
        .thinking,
    ).toEqual("abc\ndef\nghi");

    const redactedThinkingContent = assistantContent[1];
    expect(redactedThinkingContent.type).toBe("redacted_thinking");
    expect(
      (
        redactedThinkingContent as Extract<
          typeof redactedThinkingContent,
          { type: "redacted_thinking" }
        >
      ).data,
    ).toBe(
      "This thinking contains sensitive information that has been redacted.",
    );
  });
});

it("handles streaming thinking blocks correctly", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Explain how async/await works");
    await driver.send();

    const stream = await driver.mockAnthropic.mockClient.awaitStream();
    const thinkingIndex = stream.nextBlockIndex();

    // Start streaming thinking block
    stream.emitEvent({
      type: "content_block_start",
      index: thinkingIndex,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });

    // Add thinking content in multiple chunks to test streaming
    stream.emitEvent({
      type: "content_block_delta",
      index: thinkingIndex,
      delta: {
        type: "thinking_delta",
        thinking:
          "I need to explain async/await.\n\nThis is a JavaScript feature that makes asynchronous code look synchronous.",
      },
    });

    // Assert that during streaming, we see the preview with last line
    await driver.assertDisplayBufferContains(
      "💭 [Thinking] This is a JavaScript feature that makes asynchronous code look synchronous.",
    );

    // Add more content to the thinking block
    stream.emitEvent({
      type: "content_block_delta",
      index: thinkingIndex,
      delta: {
        type: "thinking_delta",
        thinking: "\n\nIt's built on top of Promises.",
      },
    });

    // Assert that the preview now shows the new last line
    await driver.assertDisplayBufferContains(
      "💭 [Thinking] It's built on top of Promises.",
    );
  });
});

it("aborts request when sending new message while waiting for response", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("First message");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();

    // Send a second message before the first request responds
    await driver.inputMagentaText("Second message while first is pending");
    await driver.send();

    // The first request should be aborted
    expect(request1.aborted).toBe(true);

    // Respond to the aborted request - this should be ignored
    request1.respond({
      stopReason: "end_turn",
      text: "This response should be ignored because request was aborted",
      toolRequests: [],
    });

    // Handle the second request
    const request2 = await driver.mockAnthropic.awaitPendingStream();
    request2.respond({
      stopReason: "end_turn",
      text: "Second response that should be shown",
      toolRequests: [],
    });

    // Verify that only the second message and response are displayed
    await driver.assertDisplayBufferContains(
      "Second message while first is pending",
    );
    await driver.assertDisplayBufferContains(
      "Second response that should be shown",
    );

    // Verify the aborted response is NOT displayed
    const bufferContent = await driver.getDisplayBufferText();
    expect(bufferContent).not.toContain(
      "This response should be ignored because request was aborted",
    );

    // Check the thread message structure - should only have the second exchange
    const thread = driver.magenta.chat.getActiveThread();
    const messages = thread.getMessages();
    expect(messages).toMatchSnapshot();
  });
});

it("aborts tool use when sending new message while tool is executing", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Run a slow command");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();
    const toolRequestId = "slow-bash-command" as ToolRequestId;

    // Respond with a tool use that would normally take time
    request1.respond({
      stopReason: "tool_use",
      text: "I'll run a slow bash command for you.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "bash_command" as ToolName,
            input: { command: "sleep 5 && echo 'This should be aborted'" },
          },
        },
      ],
    });

    // Wait for the tool execution to start
    await driver.assertDisplayBufferContains(
      "I'll run a slow bash command for you.",
    );

    // Send a new message while the tool is executing
    await driver.inputMagentaText("Cancel that, run something else");
    await driver.send();

    // Handle the second request
    await driver.mockAnthropic.awaitPendingStream();
    // Verify that the second exchange is displayed
    await driver.assertDisplayBufferContains("Cancel that, run something else");

    // Verify the aborted tool output is NOT displayed
    const bufferContent = await driver.getDisplayBufferText();
    expect(bufferContent).toContain(
      "'This should be aborted'` - Request was aborted",
    );

    // Check the thread message structure
    const thread = driver.magenta.chat.getActiveThread();
    const messages = thread.getMessages();
    expect(messages).toMatchSnapshot();
  });
});

it("inserts error tool results when aborting while stopped waiting for tool use", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Read my secret file");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();
    const toolRequestId = "get-file-tool" as ToolRequestId;

    // Respond with get_file tool use - this will block on user approval
    request1.respond({
      stopReason: "tool_use",
      text: "I'll read your secret file.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "get_file" as ToolName,
            input: { filePath: ".secret" as UnresolvedFilePath },
          },
        },
      ],
    });

    // Wait for approval dialog to appear - we're now stopped waiting for tool use
    await driver.assertDisplayBufferContains("👀⏳ May I read file `.secret`?");

    // Send a new message to abort - this should insert error tool result
    await driver.inputMagentaText("Never mind, do something else");
    await driver.send();

    // Handle the second request
    const request2 = await driver.mockAnthropic.awaitPendingStream();

    // Verify the message structure includes an error tool_result for the aborted tool
    const messagePattern = request2.messages.flatMap((m) =>
      typeof m.content == "string"
        ? "stringmessage"
        : m.content.map((c) => `${m.role}:${c.type}`),
    );

    expect(messagePattern).toEqual([
      "user:text",
      "user:text", // system_reminder
      "assistant:text",
      "assistant:tool_use",
      "user:tool_result", // error tool result from abort
      "user:text",
      "user:text", // system_reminder
    ]);

    // Verify the tool result contains the abort error message
    const userMessages = request2.messages.filter((m) => m.role === "user");
    const toolResultMessage = userMessages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((c) => c.type === "tool_result"),
    );
    expect(toolResultMessage).toBeDefined();

    const toolResultContent = (
      toolResultMessage!.content as Array<{ type: string }>
    ).find((c) => c.type === "tool_result") as {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error: boolean;
    };
    expect(toolResultContent.tool_use_id).toBe(toolRequestId);
    expect(toolResultContent.is_error).toBe(true);
    expect(toolResultContent.content).toContain("aborted by the user");
  });
});
it("handles @async messages by queueing them and sending on next tool response", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // First, send a regular message that will use a secret file read
    await driver.inputMagentaText("Can you read my secret file?");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();
    const toolRequestId = "secret-file-tool" as ToolRequestId;

    // Respond with get_file tool use - this will block on user approval
    request1.respond({
      stopReason: "tool_use",
      text: "I'll read your secret file.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "get_file" as ToolName,
            input: { filePath: ".secret" as UnresolvedFilePath },
          },
        },
      ],
    });

    // Wait for approval dialog to appear
    await driver.assertDisplayBufferContains("👀⏳ May I read file `.secret`?");

    // Now send an @async message while the tool is waiting for approval
    await driver.inputMagentaText("@async This should be queued");
    await driver.send();

    // Verify the @async message is queued, not immediately sent
    const thread = driver.magenta.chat.getActiveThread();
    expect(thread.state.pendingMessages).toHaveLength(1);
    expect(thread.state.pendingMessages[0].text).toBe("This should be queued");

    // Approve the file read to complete the tool execution
    const yesPos = await driver.assertDisplayBufferContains("[ YES ]");
    await driver.triggerDisplayBufferKey(yesPos, "<CR>");

    // Wait for file read to complete
    await driver.assertDisplayBufferContains("👀✅ `.secret`");

    // Handle the auto-response after tool completion
    const stream2 = await driver.mockAnthropic.awaitPendingStream();

    // Verify the message structure follows the expected pattern
    const messagePattern = stream2.messages.flatMap((m) =>
      typeof m.content == "string"
        ? "stringmessage"
        : m.content.map((c) => `${m.role}:${c.type}`),
    );

    expect(
      messagePattern,
      "tool_use immediately followed by tool_result",
    ).toEqual([
      "user:text",
      "user:text", // system_reminder converted to text
      "assistant:text",
      "assistant:tool_use",
      "user:tool_result",
      "user:text",
      "user:text", // system_reminder converted to text
    ]);
    expect(stream2.messages).toMatchSnapshot();
  });
});

it("handles @async messages and sends them on end turn", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Send a regular message
    await driver.inputMagentaText("Tell me about TypeScript");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();

    // Send @async message while first request is in flight
    await driver.inputMagentaText("@async Also tell me about JavaScript");
    await driver.send();

    // Verify message is queued
    const thread = driver.magenta.chat.getActiveThread();
    expect(thread.state.pendingMessages).toHaveLength(1);
    expect(thread.state.pendingMessages[0].text).toBe(
      "Also tell me about JavaScript",
    );

    // Respond to first request with end_turn - this should trigger sending queued messages
    request1.respond({
      stopReason: "end_turn",
      text: "TypeScript is a typed superset of JavaScript.",
      toolRequests: [],
    });

    // Now the queued message should be sent automatically
    const request2 = await driver.mockAnthropic.awaitPendingStream();
    expect(request2.messages).toMatchSnapshot();
  });
});

it("removes server_tool_use content when aborted before receiving results", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Search for information about TypeScript");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();

    // First send text content
    request1.streamText("I'll search for information about TypeScript.");

    // Then send server tool use streaming events
    request1.streamServerToolUse("web-search-123", "web_search", {
      query: "TypeScript programming language",
    });

    // Wait for the server tool use to be displayed
    await driver.assertDisplayBufferContains(
      "I'll search for information about TypeScript.",
    );

    // Verify the server tool use content is in the message before abort
    const thread = driver.magenta.chat.getActiveThread();
    const messages = thread.getProviderMessages();
    const contentTypesBeforeAbort = messages[messages.length - 1].content.map(
      (c) => c.type,
    );
    expect(contentTypesBeforeAbort).toEqual(["text", "server_tool_use"]);

    // Send a new message to abort the current operation before web search result comes back
    await driver.abort();
    await delay(0);

    // The server tool use should be removed since no result was received
    const messagesAfterAbort = thread.getProviderMessages();
    const contentTypesAfterAbort = messagesAfterAbort[
      messagesAfterAbort.length - 1
    ].content.map((c) => c.type);
    expect(contentTypesAfterAbort).toEqual(["text"]);
  });
});

it("should process custom commands in messages", async () => {
  await withDriver(
    {
      options: {
        customCommands: [
          {
            name: "@nedit",
            text: "DO NOT MAKE ANY EDITS TO CODE",
            description: "Disable all code editing functionality",
          },
        ],
      },
    },
    async (driver) => {
      await driver.showSidebar();
      await driver.waitForChatReady();

      await driver.inputMagentaText("@nedit Please help with this task");
      await driver.send();

      // Wait for the message to be processed and displayed
      await driver.assertDisplayBufferContains("DO NOT MAKE ANY EDITS TO CODE");
    },
  );
});
