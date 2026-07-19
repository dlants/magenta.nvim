import * as fs from "node:fs/promises";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolName, ToolRequestId } from "@magenta/core";
import { describe, expect, it } from "vitest";
import { LOGO } from "../chat/thread-view.ts";
import { getAllWindows } from "../nvim/nvim.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;

function hasUserMessageWithText(
  stream: { messages: Anthropic.MessageParam[] },
  text: string,
): boolean {
  return stream.messages.some((msg) => {
    if (msg.role !== "user") return false;
    const content = msg.content;
    if (typeof content === "string") return content.includes(text);
    if (Array.isArray(content)) {
      return content.some(
        (block) => block.type === "text" && block.text.includes(text),
      );
    }
    return false;
  });
}

describe("node/render-tools/spawn-subagents.test.ts", () => {
  it("renders a structured preview while spawn_subagents input streams in", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText("Please stream a spawn preview.");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Please stream a spawn preview.",
      );

      const fullInput = JSON.stringify({
        sharedPrompt: "do the shared thing for every agent",
        sharedContextFiles: ["shared/context.ts"],
        agents: [
          {
            agentType: "subagent",
            prompt: "the first agent task prompt",
            contextFiles: ["agent/one.ts"],
          },
        ],
      });

      const mid = Math.floor(fullInput.length / 2);

      stream.streamToolUsePartial(
        "stream-preview" as ToolRequestId,
        "spawn_subagents" as ToolName,
        [fullInput.slice(0, mid)],
      );
      await stream.settle();

      await driver.assertDisplayBufferContains("🤖 spawn_subagents:");
      await driver.assertDisplayBufferContains("sharedPrompt:");

      stream.continueToolUsePartial([fullInput.slice(mid)]);
      await stream.settle();

      await driver.assertDisplayBufferContains("agents:");
      await driver.assertDisplayBufferContains("the first agent task prompt");
      await driver.assertDisplayBufferContains("contextFiles:");
      await driver.assertDisplayBufferContains("agent/one.ts");

      stream.abort();
    });
  });

  it("<CR> on a context-file row opens that file", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(
            path.join(tmpDir, "ctx.txt"),
            "context file contents\n",
          );
        },
      },
      async (driver, dirs) => {
        await driver.showSidebar();
        await driver.inputMagentaText("Spawn an agent with a context file.");
        await driver.send();

        const ctxPath = path.join(dirs.tmpDir, "ctx.txt");

        const request1 = await driver.mockAnthropic.awaitPendingStreamWithText(
          "Spawn an agent with a context file.",
        );
        request1.respond({
          stopReason: "tool_use",
          text: "I'll spawn a sub-agent.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "spawn-ctx-file" as ToolRequestId,
                toolName: "spawn_subagents" as ToolName,
                input: {
                  agents: [
                    {
                      prompt: "Use the context file and yield.",
                      contextFiles: [ctxPath],
                    },
                  ],
                },
              },
            },
          ],
        });

        const childStream =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "Use the context file and yield.",
          );
        childStream.respond({
          stopReason: "tool_use",
          text: "Done.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "yield-ctx" as ToolRequestId,
                toolName: "yield_to_parent" as ToolName,
                input: { result: "used the context file" },
              },
            },
          ],
        });

        await driver.assertDisplayBufferContains("✅ 1 agent");
        await driver.assertDisplayBufferContains("contextFiles:");
        await driver.triggerDisplayBufferKeyOnContent(ctxPath, "<CR>");

        const targetBufferName = await pollUntil(
          async () => {
            const windows = await getAllWindows(driver.nvim);
            for (const w of windows) {
              const isMagenta = await w.getVar("magenta");
              if (isMagenta) continue;
              const buf = await w.buffer();
              const name = await buf.getName();
              if (/ctx\.txt$/.test(name)) {
                return name;
              }
            }
            throw new Error("ctx.txt not yet opened in non-magenta window");
          },
          { timeout: 2000 },
        );
        expect(targetBufferName).toMatch(/ctx\.txt$/);
      },
    );
  });

  it("spawns subagent, runs command, yields result to parent", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const thread1 = driver.getThreadId(0);

      await driver.inputMagentaText(
        "Use spawn_subagents to create a sub-agent that will echo 'Hello from subagent' and then yield that result back to me.",
      );
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Use spawn_subagents",
      );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll spawn a sub-agent to handle this task.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-spawn-subagents" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: {
                agents: [
                  {
                    prompt:
                      "Echo the text 'Hello from subagent' using the bash_command tool, then yield that result back to the parent using yield_to_parent.",
                  },
                ],
              },
            },
          },
        ],
      });

      // We should stay in the parent thread during subagent execution
      await driver.awaitChatState(
        {
          state: "thread-selected",
          id: thread1,
        },
        `We stay in the parent thread during subagent execution`,
      );

      // The child subagent runs bash_command
      const request3 =
        await driver.mockAnthropic.awaitPendingStreamWithText("Echo the text");
      request3.respond({
        stopReason: "tool_use",
        text: "I'll echo that text for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-bash-command" as ToolRequestId,
              toolName: "bash_command" as ToolName,
              input: {
                command: "echo 'Hello from subagent'",
              },
            },
          },
        ],
      });

      const request4 =
        await driver.mockAnthropic.awaitPendingStreamWithText("exit code 0");
      request4.respond({
        stopReason: "tool_use",
        text: "I'll now yield this result back to the parent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-yield-to-parent" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Successfully echoed: Hello from subagent",
              },
            },
          },
        ],
      });

      // The parent gets the spawn_subagents result after child yields
      await driver.assertDisplayBufferContains("✅ 1 agent");
    });
  });

  it("spawn_subagents view updates as agents progress and yield", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText(
        "Use spawn_subagents to create two sub-agents and wait for both.",
      );
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Use spawn_subagents",
      );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll spawn two sub-agents.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-both" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: {
                agents: [
                  {
                    prompt:
                      "Echo 'Hello from subagent 1' and yield the result.",
                  },
                  {
                    prompt:
                      "Echo 'Hello from subagent 2' and yield the result.",
                  },
                ],
              },
            },
          },
        ],
      });

      // Verify both agents are shown in progress view
      await driver.assertDisplayBufferContains("🤖 spawn_subagents");

      // First subagent yields successfully
      const subagent1Request =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Echo 'Hello from subagent 1'",
        );
      subagent1Request.respond({
        stopReason: "tool_use",
        text: "I'll yield the result back to the parent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-1" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Hello from subagent 1",
              },
            },
          },
        ],
      });

      // Verify the first agent shows as completed (✅) while the second is
      // still in progress (⏳)
      await driver.assertDisplayBufferContains("- ✅");
      await driver.assertDisplayBufferContains(
        "Echo 'Hello from subagent 1' and yield the result.",
      );

      // Second subagent yields successfully
      const subagent2Request =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Echo 'Hello from subagent 2'",
        );
      subagent2Request.respond({
        stopReason: "tool_use",
        text: "I'll yield the result back to the parent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-2" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Hello from subagent 2",
              },
            },
          },
        ],
      });

      // Verify both agents have completed
      await driver.assertDisplayBufferContains("✅ 2 agents");
    });
  });

  it("spawn_subagents progress view allows clicking to navigate to child thread", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const thread1 = driver.getThreadId(0);

      await driver.inputMagentaText(
        "Use spawn_subagents to create a sub-agent that will yield a result.",
      );
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Use spawn_subagents",
      );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll spawn a sub-agent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-test" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: {
                agents: [
                  { prompt: "Echo 'Test message' and yield the result." },
                ],
              },
            },
          },
        ],
      });

      // We should currently be in thread 1 (the parent)
      await driver.awaitChatState({
        state: "thread-selected",
        id: thread1,
      });

      // Wait for the child thread to be spawned
      await driver.awaitThreadCount(2);
      const thread2 = driver.getThreadId(1);

      // Click on the progress view to navigate to the child thread
      await driver.triggerDisplayBufferKeyOnContent("⏳", "<CR>");

      // Verify we switched to thread 2
      await driver.awaitChatState({
        state: "thread-selected",
        id: thread2,
      });

      // We should see the subagent thread content
      await driver.assertDisplayBufferContains(
        "Parent thread: Use spawn_subagents to create",
      );

      // Navigate back to thread 1 via the parent thread link
      await driver.triggerDisplayBufferKeyOnContent(
        "Parent thread: Use spawn_subagents to create",
        "<CR>",
      );

      // Verify we're back in thread 1
      await driver.awaitChatState({
        state: "thread-selected",
        id: thread1,
      });
    });
  });

  it("shows thread hierarchy with parent-child relationships", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Create a parent thread with some content
      await driver.inputMagentaText("This is the parent thread");
      await driver.send();

      const parentRequest =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "This is the parent thread",
        );
      parentRequest.respond({
        stopReason: "tool_use",
        text: "I'll spawn a subagent to help with this task.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-child" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: { agents: [{ prompt: "This is a child thread task" }] },
            },
          },
        ],
      });

      // Wait for child thread to be spawned
      await driver.awaitThreadCount(2);

      // Create another parent thread
      await driver.magenta.command("new-thread");
      await driver.awaitThreadCount(3);

      await driver.inputMagentaText("This is another parent thread");
      await driver.send();

      const parent2Request =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "This is another parent thread",
        );
      parent2Request.respond({
        stopReason: "tool_use",
        text: "I'll also spawn a subagent for this task.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-child2" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: {
                agents: [{ prompt: "This is another child thread task" }],
              },
            },
          },
        ],
      });

      // Wait for second child thread to be spawned
      await driver.awaitThreadCount(4);

      // Now view the thread hierarchy
      await driver.magenta.command("threads-overview");
      await driver.awaitChatState({
        state: "thread-overview",
      });

      // Verify hierarchical display - subtrees are collapsed by default
      await driver.assertDisplayBufferContains("# Threads");
      await driver.assertDisplayBufferContains(
        `- ▶ This is the parent thread: ⏳ executing tools (1 subthreads)`,
      );
      await driver.assertDisplayBufferContains(
        `* ▶ This is another parent thread: ⏳ executing tools (1 subthreads)`,
      );

      // Expand the first root thread to see children
      await driver.triggerDisplayBufferKeyOnContent(
        `- ▶ This is the parent thread: ⏳ executing tools (1 subthreads)`,
        "=",
      );
      await driver.assertDisplayBufferContains(
        `- ▼ This is the parent thread: ⏳ executing tools (1 subthreads)`,
      );
      await driver.assertDisplayBufferContains(
        `  - This is a child thread task: ⏳ streaming response`,
      );
    });
  });

  it("handles thread hierarchy with stopped and yielded children", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Create parent and spawn child that will yield
      await driver.inputMagentaText("Parent with yielding child");
      await driver.send();

      const parentRequest =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Parent with yielding child",
        );
      parentRequest.respond({
        stopReason: "tool_use",
        text: "I'll spawn a subagent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-yielder" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: { agents: [{ prompt: "Yield a result back to parent" }] },
            },
          },
        ],
      });

      // Wait for subagent to be spawned
      await driver.awaitThreadCount(2);

      // Child thread yields a result
      const childRequest =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Yield a result back to parent",
        );
      childRequest.respond({
        stopReason: "tool_use",
        text: "I'll yield this result.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-result" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result:
                  "This is a very long result message that should be truncated in the thread overview display",
              },
            },
          },
        ],
      });

      // Create another parent with child that stops
      await driver.magenta.command("new-thread");
      // Wait for new thread to be created
      await driver.awaitThreadCount(3);
      await driver.inputMagentaText("Parent with stopping child");
      await driver.send();

      const parent2Request =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Parent with stopping child",
        );
      parent2Request.respond({
        stopReason: "tool_use",
        text: "I'll spawn another subagent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-stopper" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: { agents: [{ prompt: "Just stop without yielding" }] },
            },
          },
        ],
      });

      // Wait for subagent to be spawned
      await driver.awaitThreadCount(4);

      // Child thread stops without yielding
      const child2Request =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Just stop without yielding",
        );
      child2Request.respond({
        stopReason: "end_turn",
        text: "I'm stopping here without yielding anything.",
        toolRequests: [],
      });

      // View thread hierarchy
      await driver.magenta.command("threads-overview");

      // Verify hierarchy shows collapsed root threads with expand indicators
      await driver.assertDisplayBufferContains(
        `- ▶ Parent with yielding child: ⏳ streaming response (1 subthreads)`,
      );
      await driver.assertDisplayBufferContains(
        `* ▶ Parent with stopping child: ⏳ executing tools (1 subthreads)`,
      );

      // Expand a root to see child states
      await driver.triggerDisplayBufferKeyOnContent(
        `* ▶ Parent with stopping child: ⏳ executing tools (1 subthreads)`,
        "=",
      );
      await driver.assertDisplayBufferContains(
        `* ▼ Parent with stopping child: ⏳ executing tools (1 subthreads)`,
      );
      await driver.assertDisplayBufferContains(
        `  - 🔔 Just stop without yielding: ⏹️ stopped (end_turn)`,
      );
    });
  });

  it("allows selecting parent and child threads from hierarchy view", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();
      const thread1 = driver.getThreadId(0);

      // Create parent thread
      await driver.inputMagentaText("Parent thread message");
      await driver.send();

      const parentRequest =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Parent thread message",
        );
      parentRequest.respond({
        stopReason: "tool_use",
        text: "Spawning a child thread.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-test-child" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: { agents: [{ prompt: "Child thread task" }] },
            },
          },
        ],
      });

      // Wait for the subagent to be spawned
      await driver.awaitThreadCount(2);
      const thread2 = driver.getThreadId(1);

      await driver.magenta.command("threads-overview");

      // Expand the root thread to see children
      await driver.triggerDisplayBufferKeyOnContent(
        `* ▶ Parent thread message: ⏳ executing tools (1 subthreads)`,
        "=",
      );

      await driver.triggerDisplayBufferKeyOnContent(
        `  - Child thread task: ⏳ streaming response`,
        "<CR>",
      );

      await driver.awaitChatState({
        state: "thread-selected",
        id: thread2,
      });
      await driver.assertDisplayBufferContains(
        `Parent thread: Parent thread message`,
      );

      await driver.magenta.command("threads-overview");
      await driver.triggerDisplayBufferKeyOnContent(
        `- 🔔 ▼ Parent thread message: ⏳ executing tools (1 subthreads)`,
        "<CR>",
      );

      // Verify we switched to the parent thread
      await driver.awaitChatState({
        state: "thread-selected",
        id: thread1,
      });
      await driver.assertDisplayBufferContains("Parent thread message");
    });
  });

  it("formats thread status correctly for different states", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      // Create a thread and let it complete normally
      await driver.inputMagentaText("Test message");
      await driver.send();

      const request =
        await driver.mockAnthropic.awaitPendingStreamWithText("Test message");
      request.streamText("Assistant response");
      request.finishResponse("end_turn");

      // Create another thread that will spawn a subagent
      await driver.magenta.command("new-thread");
      await driver.assertDisplayBufferContains("# [ Untitled ]");
      await driver.assertDisplayBufferContains(LOGO);
      await driver.inputMagentaText("Spawn subagents");
      await driver.send();

      const request2 =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Spawn subagents",
        );
      request2.respond({
        stopReason: "tool_use",
        text: "Spawning subagent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-for-status" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: { agents: [{ prompt: "Child task" }] },
            },
          },
        ],
      });

      // View threads overview to see different status formats
      await driver.magenta.command("threads-overview");

      // Verify different status displays
      await driver.assertDisplayBufferContains(
        `- Test message: ⏹️ stopped (end_turn)`,
      );
    });
  });

  it("spawn_subagents waits for completion and returns result", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText("Use spawn_subagents to get a result.");
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Use spawn_subagents",
      );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll spawn a sub-agent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-spawn" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: {
                agents: [{ prompt: "Do a task and yield back the result." }],
              },
            },
          },
        ],
      });

      // Verify spawn_subagents shows waiting state
      await driver.assertDisplayBufferContains("🤖 spawn_subagents: 1 agent");

      // The subagent should start running
      const subagentRequest =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Do a task and yield back",
        );
      subagentRequest.respond({
        stopReason: "tool_use",
        text: "I completed the task.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-result" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "Task completed successfully",
              },
            },
          },
        ],
      });

      // After subagent yields, the spawn should complete
      await driver.assertDisplayBufferContains("✅ 1 agent");

      // The parent thread should continue with the result
      const parentContinue =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Task completed successfully",
        );
      parentContinue.respond({
        stopReason: "end_turn",
        text: "Great, the subagent returned successfully.",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContains(
        "Great, the subagent returned successfully.",
      );
    });
  });

  it("navigates to subagent thread when clicking on spawn_subagents completed summary", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText(
        "Use spawn_subagents to create a sub-agent.",
      );
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Use spawn_subagents",
      );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll spawn a sub-agent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-nav-spawn" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: {
                agents: [{ prompt: "Child thread for navigation test." }],
              },
            },
          },
        ],
      });

      // Wait for child to start, then have it yield so spawn_subagents completes
      const childStream = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Child thread for navigation test",
      );
      childStream.respond({
        stopReason: "tool_use",
        text: "Done.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-nav" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: { result: "Navigation test done" },
            },
          },
        ],
      });

      await driver.assertDisplayBufferContains("✅ 1 agent");
      const thread2 = driver.getThreadId(1);

      // Click on the result row to navigate to the subagent thread
      await driver.triggerDisplayBufferKeyOnContent(
        "Child thread for navigation test",
        "<CR>",
      );

      // Verify we navigated to the subagent thread
      await pollUntil(
        () => driver.magenta.chat.getActiveThread().id === thread2,
      );

      // We should see the subagent thread content
      await driver.assertDisplayBufferContains(
        "Parent thread: Use spawn_subagents to create a sub-agent.",
      );
    });
  });

  it("shows pending approvals from subagent in parent progress view", async () => {
    await withDriver({}, async (driver) => {
      driver.mockSandbox.setState({
        status: "unsupported",
        reason: "disabled",
      });
      await driver.showSidebar();
      const thread1 = driver.getThreadId(0);

      await driver.inputMagentaText(
        "Use spawn_subagents to read a secret file.",
      );
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Use spawn_subagents",
      );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll spawn a sub-agent to read the file.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-approval" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: {
                agents: [{ prompt: "Read the .secret file and report back." }],
              },
            },
          },
        ],
      });

      // Stay in parent thread
      await driver.awaitChatState({
        state: "thread-selected",
        id: thread1,
      });

      // Child subagent requests bash_command (needs approval when sandbox disabled)
      const childStream = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Read the .secret file",
      );
      childStream.respond({
        stopReason: "tool_use",
        text: "I'll read the secret file.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "child-bash" as ToolRequestId,
              toolName: "bash_command" as ToolName,
              input: { command: "cat .secret" },
            },
          },
        ],
      });

      // The parent thread's progress view should show the pending approval
      // from the child thread inline
      await driver.assertDisplayBufferContains("May I run command");
    });
  });

  it("pressing = on a progress row expands to show the full prompt, pressing again collapses", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText(
        "Use spawn_subagents to create a sub-agent.",
      );
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Use spawn_subagents",
      );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll spawn a sub-agent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-expand-test" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: {
                agents: [
                  {
                    prompt:
                      "HEADMARKEREXPAND this prompt is intentionally long enough that the beginning is trimmed from the tail preview shown in the collapsed progress row.",
                  },
                ],
              },
            },
          },
        ],
      });

      // Wait for the child thread to be spawned and progress to show
      await driver.awaitThreadCount(2);
      await driver.assertDisplayBufferContains("⏳");

      // The head of the prompt should NOT be visible yet (only the tail
      // preview shows, which trims the beginning)
      await driver.assertDisplayBufferDoesNotContain("HEADMARKEREXPAND");

      // Press = on the progress row to expand it
      await driver.triggerDisplayBufferKeyOnContent("⏳", "=");

      // Now the full prompt (including its head) should be visible
      await driver.assertDisplayBufferContains("HEADMARKEREXPAND");

      // Press = again to collapse
      await driver.triggerDisplayBufferKeyOnContent("⏳", "=");

      // The head should be hidden again
      await driver.assertDisplayBufferDoesNotContain("HEADMARKEREXPAND");
    });
  });

  it("pressing = on a completed result row expands to show prompt and response", async () => {
    await withDriver({}, async (driver) => {
      await driver.showSidebar();

      await driver.inputMagentaText(
        "Use spawn_subagents to create a sub-agent.",
      );
      await driver.send();

      const request1 = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Use spawn_subagents",
      );
      request1.respond({
        stopReason: "tool_use",
        text: "I'll spawn a sub-agent.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "spawn-result-expand" as ToolRequestId,
              toolName: "spawn_subagents" as ToolName,
              input: {
                agents: [
                  {
                    prompt:
                      "This is the full prompt text that should show when result is expanded.",
                  },
                ],
              },
            },
          },
        ],
      });

      // Child yields
      const childStream =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "full prompt text",
        );
      childStream.respond({
        stopReason: "tool_use",
        text: "Done with the task.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "yield-expand" as ToolRequestId,
              toolName: "yield_to_parent" as ToolName,
              input: {
                result: "This is the yielded response body from the subagent.",
              },
            },
          },
        ],
      });

      // Wait for completion
      await driver.assertDisplayBufferContains("✅ 1 agent");

      // Neither the full prompt nor the response body should be visible yet
      await driver.assertDisplayBufferDoesNotContain("**Prompt:**");
      await driver.assertDisplayBufferDoesNotContain(
        "yielded response body from the subagent",
      );

      // Press = on the result row to expand
      await driver.triggerDisplayBufferKeyOnContent(
        "This is the full prompt text that should show",
        "=",
      );

      // Now both prompt and response should be visible
      await driver.assertDisplayBufferContains("**Prompt:**");
      await driver.assertDisplayBufferContains(
        "full prompt text that should show when result is expanded",
      );
      await driver.assertDisplayBufferContains("**Response:**");
      await driver.assertDisplayBufferContains(
        "yielded response body from the subagent",
      );

      // Press = again to collapse
      await driver.triggerDisplayBufferKeyOnContent(
        "This is the full prompt text that should show",
        "=",
      );

      // Prompt and response should be hidden
      await driver.assertDisplayBufferDoesNotContain("**Prompt:**");
      await driver.assertDisplayBufferDoesNotContain("**Response:**");
    });
  });

  describe("abort does not resolve parent tool calls", () => {
    it("blocking spawn_subagents stays pending when child is aborted, resolves on yield", async () => {
      await withDriver({}, async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText("Use a blocking subagent.");
        await driver.send();

        const parentStream =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "blocking subagent",
          );

        parentStream.respond({
          stopReason: "tool_use",
          text: "Spawning blocking subagent.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "blocking-spawn" as ToolRequestId,
                toolName: "spawn_subagents" as ToolName,
                input: {
                  agents: [{ prompt: "Do the task and yield the result" }],
                },
              },
            },
          ],
        });

        const childStream = await driver.mockAnthropic.awaitPendingStream({
          predicate: (stream) => hasUserMessageWithText(stream, "Do the task"),
          message: "waiting for blocking subagent stream",
        });

        await driver.awaitThreadCount(2);
        const parentThreadId = driver.getThreadId(0);
        const childThreadId = driver
          .getThreadIds()
          .find((id) => id !== parentThreadId)!;

        // Abort the child thread directly
        driver.magenta.chat.update({
          type: "thread-msg",
          id: childThreadId,
          msg: { type: "abort" },
        });
        expect(childStream.aborted).toBe(true);

        // Verify the child shows as aborted in the parent thread view
        await driver.assertDisplayBufferContains("stopped (aborted)");
        // Verify the parent is still waiting (spawn still pending)
        await driver.assertDisplayBufferContains("🤖 spawn_subagents");
        await driver.assertDisplayBufferDoesNotContain("✅ 1 agent");

        // Resume the child: switch to it, send a message
        driver.magenta.dispatch({
          type: "select-thread-effect",
          id: childThreadId,
        });
        await pollUntil(
          () => driver.magenta.chat.getActiveThread().id === childThreadId,
        );
        await driver.inputMagentaText("Continue the task");
        await driver.send();

        const resumedStream =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "Continue the task",
          );

        // Child yields
        resumedStream.respond({
          stopReason: "tool_use",
          text: "Done.",
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

        // Parent should now receive a tool result containing the yield
        const parentResume = await driver.mockAnthropic.awaitPendingStream({
          predicate: (stream) =>
            stream.messages.some(
              (msg) =>
                msg.role === "user" &&
                Array.isArray(msg.content) &&
                msg.content.some(
                  (block): block is ToolResultBlockParam =>
                    block.type === "tool_result" &&
                    block.tool_use_id === "blocking-spawn",
                ),
            ),
          message: "waiting for parent to receive tool result",
        });

        let toolResult: ToolResultBlockParam | undefined;
        for (const msg of parentResume.messages) {
          if (msg.role === "user" && Array.isArray(msg.content)) {
            const found = msg.content.find(
              (block): block is ToolResultBlockParam =>
                block.type === "tool_result" &&
                block.tool_use_id === "blocking-spawn",
            );
            if (found) {
              toolResult = found;
              break;
            }
          }
        }
        expect(toolResult).toBeDefined();
        expect(toolResult!.is_error).toBe(false);
        expect(JSON.stringify(toolResult!.content)).toContain(
          "The answer is 42",
        );
      });
    });

    it("spawn_subagents stays pending when child is aborted, resolves on yield", async () => {
      await withDriver(
        { options: { maxConcurrentSubagents: 10 } },
        async (driver) => {
          await driver.showSidebar();
          await driver.inputMagentaText("Process elements.");
          await driver.send();

          const stream1 =
            await driver.mockAnthropic.awaitPendingStreamWithText(
              "Process elements",
            );
          stream1.respond({
            stopReason: "tool_use",
            text: "Processing.",
            toolRequests: [
              {
                status: "ok",
                value: {
                  id: "subagents-tool" as ToolRequestId,
                  toolName: "spawn_subagents" as ToolName,
                  input: { agents: [{ prompt: "Handle this element" }] },
                },
              },
            ],
          });

          // Wait for the child stream
          const childStream =
            await driver.mockAnthropic.awaitPendingStreamWithText(
              "Handle this element",
            );

          await driver.awaitThreadCount(2);
          const parentThreadId = driver.getThreadId(0);
          const childThreadId = driver
            .getThreadIds()
            .find((id) => id !== parentThreadId)!;

          // Abort the child
          driver.magenta.chat.update({
            type: "thread-msg",
            id: childThreadId,
            msg: { type: "abort" },
          });
          expect(childStream.aborted).toBe(true);

          // Verify the child shows as aborted
          await driver.assertDisplayBufferContains("stopped (aborted)");

          // Resume the child
          driver.magenta.dispatch({
            type: "select-thread-effect",
            id: childThreadId,
          });
          await pollUntil(
            () => driver.magenta.chat.getActiveThread().id === childThreadId,
          );
          await driver.inputMagentaText("Continue the element");
          await driver.send();

          const resumedStream =
            await driver.mockAnthropic.awaitPendingStreamWithText(
              "Continue the element",
            );

          resumedStream.respond({
            stopReason: "tool_use",
            text: "Done.",
            toolRequests: [
              {
                status: "ok",
                value: {
                  id: "yield-result" as ToolRequestId,
                  toolName: "yield_to_parent" as ToolName,
                  input: { result: "Element completed" },
                },
              },
            ],
          });

          // Parent should receive the result
          const parentResume = await driver.mockAnthropic.awaitPendingStream({
            predicate: (stream) =>
              stream.messages.some(
                (msg) =>
                  msg.role === "user" &&
                  Array.isArray(msg.content) &&
                  msg.content.some(
                    (block): block is ToolResultBlockParam =>
                      block.type === "tool_result" &&
                      block.tool_use_id === "subagents-tool",
                  ),
              ),
            message: "waiting for parent to receive result",
          });

          let toolResult: ToolResultBlockParam | undefined;
          for (const msg of parentResume.messages) {
            if (msg.role === "user" && Array.isArray(msg.content)) {
              const found = msg.content.find(
                (block): block is ToolResultBlockParam =>
                  block.type === "tool_result" &&
                  block.tool_use_id === "subagents-tool",
              );
              if (found) {
                toolResult = found;
                break;
              }
            }
          }
          expect(toolResult).toBeDefined();
          expect(toolResult!.is_error).toBe(false);
          expect(JSON.stringify(toolResult!.content)).toContain(
            "Element completed",
          );
        },
      );
    });

    it("aborting parent thread while subagent is running aborts the spawn", async () => {
      await withDriver({}, async (driver) => {
        await driver.showSidebar();
        await driver.inputMagentaText("Use spawn_subagents to do work.");
        await driver.send();

        const parentStream =
          await driver.mockAnthropic.awaitPendingStreamWithText(
            "Use spawn_subagents to do work",
          );

        parentStream.respond({
          stopReason: "tool_use",
          text: "Spawning subagent.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "parent-abort-spawn" as ToolRequestId,
                toolName: "spawn_subagents" as ToolName,
                input: {
                  agents: [{ prompt: "Long running task for parent abort" }],
                },
              },
            },
          ],
        });

        // Wait for child to start running
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Long running task for parent abort",
        );
        await driver.awaitThreadCount(2);

        const parentThreadId = driver.getThreadId(0);

        // Abort the parent thread
        driver.magenta.chat.update({
          type: "thread-msg",
          id: parentThreadId,
          msg: { type: "abort" },
        });

        // The parent should show the aborted state
        await driver.assertDisplayBufferContains("[ABORTED]");
        await driver.assertDisplayBufferContains("❌ Request was aborted");
      });
    });
  });
});
