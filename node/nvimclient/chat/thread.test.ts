import fs from "node:fs";
import * as os from "node:os";
import type { WebSearchResultBlock } from "@anthropic-ai/sdk/resources.mjs";
import type { ToolName, ToolRequestId } from "@magenta/server";
import lodash from "lodash";
import { expect, it } from "vitest";
import { $, within } from "zx";
import { getcwd } from "../nvim/nvim.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";
import type { HomeDir, UnresolvedFilePath } from "../utils/files.ts";
import { resolveFilePath } from "../utils/files.ts";
import { LOGO } from "./thread-view.ts";

/** Sanitize display buffer text for stable snapshots by removing dynamic content */
function sanitizeDisplayForSnapshot(text: string): string {
  // Replace timing info like "exit code 0 (16ms)" with stable placeholder
  return text.replace(/\((\d+)ms\)/g, "(<timing>ms)");
}

/** Replace dynamic thread IDs and timing info in messages with a placeholder for stable snapshots */

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

it("handles errors during streaming response", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Test error handling during response");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();

    // Simulate an error during streaming
    const errorMessage = "Simulated error during streaming";
    stream.respondWithError(new Error(errorMessage));

    // After a non-retryable error nothing is discarded: the failed message
    // and the error are rendered so the user can see what they sent and why
    // it failed, and the input buffer is left alone.
    await driver.assertDisplayBufferContains(
      "Test error handling during response",
    );
    await driver.assertDisplayBufferContains("Error");
    await driver.assertDisplayBufferContains(errorMessage);

    // The error block is the previous submission's, so it survives until the
    // next one starts rather than until the next render.
    await driver.inputMagentaText("Second attempt");
    await driver.send();
    await driver.assertDisplayBufferDoesNotContain(errorMessage);
  });
});

it("renders a long pending message trimmed with expand/collapse toggle", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Original message");
    await driver.send();

    await driver.mockAnthropic.awaitPendingStream();

    const longText = Array.from({ length: 60 }, (_, i) => `word${i + 1}`).join(
      " ",
    );
    await driver.inputMagentaText(`@async ${longText}`);
    await driver.send();

    const thread = driver.magenta.chat.getActiveThread();
    expect(thread.thread.queued.async).toHaveLength(1);

    await driver.assertDisplayBufferContains("✉️ queued:");
    await driver.assertDisplayBufferContains("word1");
    await driver.assertDisplayBufferContains("[expand]");
    // Text past the preview threshold is hidden by default.
    await driver.assertDisplayBufferDoesNotContain("word60");

    await driver.triggerDisplayBufferKeyOnContent("[expand]", "=");

    await driver.assertDisplayBufferContains("word60");
    await driver.assertDisplayBufferContains("[collapse]");
    // View-only toggle must not mutate the queue.
    expect(thread.thread.queued.async).toHaveLength(1);

    await driver.triggerDisplayBufferKeyOnContent("[collapse]", "=");
    await driver.assertDisplayBufferContains("[expand]");
    await driver.assertDisplayBufferDoesNotContain("word60");
  });
});

it("clears pending expand state when the queue drains", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Original message");
    await driver.send();

    const request1 = await driver.mockAnthropic.awaitPendingStream();

    const longText = Array.from({ length: 60 }, (_, i) => `word${i + 1}`).join(
      " ",
    );
    await driver.inputMagentaText(`@async ${longText}`);
    await driver.send();

    const thread = driver.magenta.chat.getActiveThread();
    expect(thread.thread.queued.async).toHaveLength(1);

    // Expand the queued message so index 0 is marked expanded.
    await driver.triggerDisplayBufferKeyOnContent("[expand]", "=");
    await driver.assertDisplayBufferContains("word60");
    expect(thread.state.pendingMessagesExpanded[0]).toBe(true);

    // End the turn so the queued message drains and is sent.
    request1.respond({
      stopReason: "end_turn",
      text: "done",
      toolRequests: [],
    });

    const request2 = await driver.mockAnthropic.awaitPendingStream();
    await pollUntil(() => {
      if (thread.thread.queued.async.length !== 0) {
        throw new Error("queue not drained yet");
      }
      // The clear rides the debounced re-render, not the drain itself.
      if (Object.keys(thread.state.pendingMessagesExpanded).length !== 0) {
        throw new Error("expand state not cleared yet");
      }
    });
    // Draining the queue must clear stale expand state keyed by index.
    expect(thread.state.pendingMessagesExpanded).toEqual({});

    // Queue another long message at the same index while the new turn streams.
    await driver.inputMagentaText(`@async ${longText}`);
    await driver.send();

    expect(thread.thread.queued.async).toHaveLength(1);
    // The newly-queued message must render collapsed by default (state was
    // cleared on drain, so index 0 is not stale-expanded).
    await driver.assertDisplayBufferContains("[expand]");
    expect(thread.state.pendingMessagesExpanded).toEqual({});

    request2.respond({
      stopReason: "end_turn",
      text: "done2",
      toolRequests: [],
    });
  });
});

it("processes @buf keyword to include buffers list in message", {
  timeout: 10000,
}, async () => {
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
    await driver.assertDisplayBufferContains("Help me organize my files @buf");

    // Verify the buffers list is appended as a separate content block
    await driver.assertDisplayBufferContains("Current buffers list:");
    await driver.assertDisplayBufferContains("poem.txt");
    await driver.assertDisplayBufferContains("active poem2.txt");

    // Check the thread message structure
    const thread = driver.magenta.chat.getActiveThread();
    const messages = thread.thread.getProviderMessages();

    // Should have user message and assistant response
    expect(messages.length).toBe(2);

    // The user message should have three content blocks: original text + buffers list (after system_info)
    expect(messages[0].content.length).toBe(4);
    expect(messages[0].content[0].type).toBe("system_info");
    const content0 = messages[0].content[2];
    expect(content0.type).toBe("text");
    expect((content0 as Extract<typeof content0, { type: "text" }>).text).toBe(
      "Help me organize my files @buf",
    );
    const content1 = messages[0].content[3];
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
});

it("processes @diff command to include git diff in message", {
  timeout: 10000,
}, async () => {
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
});

it("processes @staged command to include staged diff in message", {
  timeout: 10000,
}, async () => {
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
});

it("handles @file command with non-existent file", {
  timeout: 10000,
}, async () => {
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
    await driver.assertDisplayBufferContains("Help with @file:nonexistent.txt");

    // Verify error message is included
    await driver.assertDisplayBufferContains("Error adding file to context");
    await driver.assertDisplayBufferContains("nonexistent.txt");

    // Check the thread message structure
    const thread = driver.magenta.chat.getActiveThread();
    const messages = thread.thread.getProviderMessages();

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
});

it.skip("display multiple edits to the same file, and edit details", async () => {
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

    await driver.triggerDisplayBufferKeyOnContent("diff snapshot", "<CR>");

    await driver.assertDisplayBufferContains(`\
# assistant:
ok, I will try to rewrite the poem in that file
✏️✅ Replace [[ -4 / +2 ]] in \`poem.txt\``);

    // Go back to main view
    await driver.triggerDisplayBufferKeyOnContent("diff snapshot", "<CR>");

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
      os.homedir() as HomeDir,
    );
    const tempContent = "temporary file content\nfor testing deletion";
    await fs.promises.writeFile(tempFilePath, tempContent);

    // Add file to context
    await driver.addContextFiles("temp-delete-test.txt");

    // Verify file is in context (with pending whole-file send since never read by agent)
    await driver.assertDisplayBufferContains(`- \`temp-delete-test.txt\``);

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
    await driver.assertDisplayBufferContains("🌐 1 search result");

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

    // Real responses always follow thinking with text/tool_use. Without a
    // trailing non-thinking block, the assistant message would be stripped
    // before being re-sent (Anthropic rejects messages ending in thinking).
    stream.streamText("Here are some considerations.");

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
    await driver.triggerDisplayBufferKeyOnContent("💭 [Thinking]", "=");

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
    await driver.triggerDisplayBufferKeyOnContent("💭 [Thinking]", "=");

    // Verify collapsed thinking block again - check pieces separately
    await driver.assertDisplayBufferContains("# user:");
    await driver.assertDisplayBufferContains(
      "What should I consider when designing a database schema?",
    );
    await driver.assertDisplayBufferContains("# assistant:");
    await driver.assertDisplayBufferContains("💭 [Thinking]");
    await driver.assertDisplayBufferContains("💭 [Redacted Thinking]");
  });
});

it("handles streaming thinking blocks correctly", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Explain how async/await works");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();
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

it("shows EDL script preview while streaming", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Edit a file for me");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();
    const toolIndex = stream.nextBlockIndex();

    // Start streaming an edl tool_use block
    stream.emitEvent({
      type: "content_block_start",
      index: toolIndex,
      content_block: {
        type: "tool_use",
        id: "edl-preview-test",
        name: "edl",
        input: {},
        caller: { type: "direct" as const },
      },
    });

    // Stream partial input JSON with escaped newlines
    stream.emitEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: '{"script": "file `src/utils.ts`\\nselect',
      },
    });

    // Assert the display shows a file summary and the streaming tail
    await driver.assertDisplayBufferContains("📝 edl: editing 1 file:");
    await driver.assertDisplayBufferContains("src/utils.ts");
    await driver.assertDisplayBufferContains("select");

    // Stream more of the script
    stream.emitEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: " /oldFunc/\\nextend_forward",
      },
    });

    await driver.assertDisplayBufferContains("extend_forward");
  });
});
it("shows bash_command preview while streaming", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Run a command for me");
    await driver.send();

    const stream = await driver.mockAnthropic.awaitPendingStream();
    const toolIndex = stream.nextBlockIndex();

    stream.emitEvent({
      type: "content_block_start",
      index: toolIndex,
      content_block: {
        type: "tool_use",
        id: "bash-preview-test",
        name: "bash_command",
        input: {},
        caller: { type: "direct" as const },
      },
    });

    stream.emitEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: '{"command": "echo hello',
      },
    });

    await driver.assertDisplayBufferContains("⚡");
    await driver.assertDisplayBufferContains("echo hello");

    stream.emitEvent({
      type: "content_block_delta",
      index: toolIndex,
      delta: {
        type: "input_json_delta",
        partial_json: ' && echo world"}',
      },
    });

    await driver.assertDisplayBufferContains("echo world");
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

it("renders successive tool uses with single assistant header and inline metadata", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("Read two files for me");
    await driver.send();

    const stream1 = await driver.mockAnthropic.awaitPendingStream();

    // First tool use
    stream1.respond({
      stopReason: "tool_use",
      text: "I'll read the first file.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool-1" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: { files: [{ filePath: "poem.txt" as UnresolvedFilePath }] },
          },
        },
      ],
    });

    // Wait for first tool to complete (auto-approved for poem.txt)
    await driver.assertDisplayBufferContains("✅ ");

    // Second request - thinking then another tool use
    const stream2 = await driver.mockAnthropic.awaitPendingStream();
    stream2.streamThinking("Let me read the second file now.");
    stream2.respond({
      stopReason: "tool_use",
      text: "",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool-2" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: { files: [{ filePath: "poem2.txt" as UnresolvedFilePath }] },
          },
        },
      ],
    });

    // Wait for second tool to complete
    await driver.assertDisplayBufferContains("✅ ");

    // Third request - final response
    const stream3 = await driver.mockAnthropic.awaitPendingStream();
    stream3.respond({
      stopReason: "end_turn",
      text: "I've read both files for you.",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("I've read both files for you.");

    // Get the display buffer and verify the format via snapshot
    const displayText = sanitizeDisplayForSnapshot(
      await driver.getDisplayBufferText(),
    );

    // Snapshot the full display to verify:
    // 1. Only ONE "# assistant:" header for the entire turn
    // 2. System reminders and checkpoints are inline (📋 [System Reminder]🏁 [Checkpoint])
    // 3. No blank lines between tool results and metadata
    expect(displayText).toMatchSnapshot("successive-tool-uses-display");
  });
});

it("followup user message text is visible after tool-use cycle", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Send initial message
    await driver.inputMagentaText("Read a file for me");
    await driver.send();

    const stream1 = await driver.mockAnthropic.awaitPendingStream();
    const toolRequestId = "read-file-1" as ToolRequestId;

    // Respond with a tool use
    stream1.respond({
      stopReason: "tool_use",
      text: "I'll read the file for you.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: toolRequestId,
            toolName: "get_files" as ToolName,
            input: {
              files: [{ filePath: "./poem.txt" as UnresolvedFilePath }],
            },
          },
        },
      ],
    });

    // Wait for tool to auto-execute and complete
    await driver.assertDisplayBufferContains("poem.txt");

    // Auto-respond after tool completion
    const stream2 = await driver.mockAnthropic.awaitPendingStream();
    stream2.respond({
      stopReason: "end_turn",
      text: "I've read the file. It contains a poem about moonlight.",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("poem about moonlight");

    // Now send a followup message
    await driver.inputMagentaText("Now edit the poem to be about sunshine");
    await driver.send();

    const stream3 = await driver.mockAnthropic.awaitPendingStream();
    stream3.respond({
      stopReason: "end_turn",
      text: "I'll edit the poem for you.",
      toolRequests: [],
    });

    // Verify the followup user message text is visible in the display
    await driver.assertDisplayBufferContains(
      "Now edit the poem to be about sunshine",
    );

    // Verify the assistant response to the followup is also visible
    await driver.assertDisplayBufferContains("I'll edit the poem for you.");

    // Wait for the stream to fully settle so the snapshot is deterministic.
    await driver.assertDisplayBufferContains("Stopped (end_turn)");

    // Snapshot the full display for verification
    const displayText = sanitizeDisplayForSnapshot(
      await driver.getDisplayBufferText(),
    );
    expect(displayText).toMatchSnapshot("followup-message-after-tool-use");
  });
});

it("followup user message text is visible with context updates", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // Add a file to context and send initial message
    await driver.addContextFiles("poem.txt");
    await driver.inputMagentaText("Help me with this poem");
    await driver.send();

    const stream1 = await driver.mockAnthropic.awaitPendingStream();
    stream1.respond({
      stopReason: "end_turn",
      text: "I can see the poem. What would you like me to do?",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("What would you like me to do?");

    // Modify the file externally to trigger a context update on next message
    const cwd = await getcwd(driver.nvim);
    await fs.promises.writeFile(
      `${cwd}/poem.txt`,
      "sunshine poem\nwith extra lines",
    );

    // Send a followup message - this should include context updates
    await driver.inputMagentaText("Now make the poem longer please");
    await driver.send();

    const stream2 = await driver.mockAnthropic.awaitPendingStream();
    stream2.respond({
      stopReason: "end_turn",
      text: "I'll make the poem longer.",
      toolRequests: [],
    });

    // Verify the followup user message text is visible in the display
    await driver.assertDisplayBufferContains("Now make the poem longer please");

    // Verify the assistant response to the followup is also visible
    await driver.assertDisplayBufferContains("I'll make the poem longer.");

    // Wait for the stream to fully settle so the snapshot is deterministic.
    await driver.assertDisplayBufferContains("Stopped (end_turn)");

    // Snapshot the full display for verification
    const displayText = sanitizeDisplayForSnapshot(
      await driver.getDisplayBufferText(),
    );
    expect(displayText).toMatchSnapshot("followup-with-context-updates");
  });
});
it("expands context update diff with = binding", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.addContextFiles("poem.txt");
    await driver.inputMagentaText("Help me with this poem");
    await driver.send();

    const stream1 = await driver.mockAnthropic.awaitPendingStream();
    stream1.respond({
      stopReason: "end_turn",
      text: "What would you like me to do?",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("What would you like me to do?");

    const cwd = await getcwd(driver.nvim);
    await fs.promises.writeFile(
      `${cwd}/poem.txt`,
      "sunshine poem\nwith extra lines",
    );

    await driver.inputMagentaText("Now make the poem longer please");
    await driver.send();

    const stream2 = await driver.mockAnthropic.awaitPendingStream();
    stream2.respond({
      stopReason: "end_turn",
      text: "I'll make the poem longer.",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("Context Updates:");

    // Expand the diff using the "=" binding on the file line. Resolve the
    // binding by content to avoid a re-render race with the streaming spinner
    // shifting line positions out from under a cached cursor position.
    await driver.triggerDisplayBufferKeyOnContent("`poem.txt` [ +2 / -4,", "=");

    await driver.assertDisplayBufferContains("+with extra lines");
  });
});

it("disposing the view leaves the thread and its in-flight request alone", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    await driver.inputMagentaText("hello");
    await driver.send();
    const stream = await driver.mockAnthropic.awaitPendingStream();
    const wrapper = driver.magenta.chat.getActiveThread();
    wrapper.dispose();
    expect(wrapper.thread.isDestroyed).toBe(false);
    expect(stream.aborted).toBe(false);
    stream.respond({ stopReason: "end_turn", text: "hi", toolRequests: [] });
    await pollUntil(() => {
      if (wrapper.thread.isBusy) throw new Error("thread still busy");
    });
  });
});
