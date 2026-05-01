import type { ToolName, ToolRequestId } from "@magenta/core";
import { expect, it } from "vitest";
import { getCurrentWindow } from "../nvim/nvim.ts";
import { withDriver } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";

it("normal mode F on a previous assistant message creates a fork ending there", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();
    const visibleState = driver.getVisibleState();
    const inputWindow = visibleState.inputWindow;

    await driver.inputMagentaText("What is the capital of France?");
    await driver.send();

    const r1 = await driver.mockAnthropic.awaitPendingStream();
    r1.respond({
      stopReason: "end_turn",
      text: "The capital of France is Paris.",
      toolRequests: [],
    });

    await driver.inputMagentaText("What about Germany?");
    await driver.send();

    const r2 = await driver.mockAnthropic.awaitPendingStream();
    r2.respond({
      stopReason: "end_turn",
      text: "The capital of Germany is Berlin.",
      toolRequests: [],
    });

    const originalThreadId = driver.magenta.chat.state.activeThreadId;

    await driver.pressOnDisplayMessage("The capital of France is Paris.", "F");

    await pollUntil(() => {
      if (driver.magenta.chat.state.activeThreadId === originalThreadId) {
        throw new Error("Still on original thread");
      }
    });

    const newThread = driver.magenta.chat.getActiveThread();
    expect(newThread.id).not.toBe(originalThreadId);

    // The new thread should have native messages [user, assistant]
    const native = newThread.agent
      .getState()
      .messages.filter((m) => m.role !== "user" || m.content.length > 0);
    expect(native).toHaveLength(2);

    // Input buffer should be empty
    const inputBuffer = driver.getInputBuffer();
    const lines = await inputBuffer.getLines({
      start: 0 as never,
      end: -1 as never,
    });
    expect(lines).toEqual([""]);

    // Cursor should be in input window
    const currentWin = await getCurrentWindow(driver.nvim);
    expect(currentWin.id).toBe(inputWindow.id);
  });
});

it("normal mode F on a user message keeps that user message", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("What is the capital of France?");
    await driver.send();

    const r1 = await driver.mockAnthropic.awaitPendingStream();
    r1.respond({
      stopReason: "end_turn",
      text: "The capital of France is Paris.",
      toolRequests: [],
    });

    await driver.inputMagentaText("What about Germany?");
    await driver.send();

    const r2 = await driver.mockAnthropic.awaitPendingStream();
    r2.respond({
      stopReason: "end_turn",
      text: "The capital of Germany is Berlin.",
      toolRequests: [],
    });

    const originalThreadId = driver.magenta.chat.state.activeThreadId;

    await driver.pressOnDisplayMessage("What about Germany?", "F");

    await pollUntil(() => {
      if (driver.magenta.chat.state.activeThreadId === originalThreadId) {
        throw new Error("Still on original thread");
      }
    });

    const newThread = driver.magenta.chat.getActiveThread();
    const messages = newThread.agent.getState().messages;
    expect(messages).toHaveLength(3);
    const last = messages[messages.length - 1];
    expect(last.role).toBe("user");
  });
});

it("normal mode F on assistant message with tool_use extends to keep tool_result", async () => {
  await withDriver({}, async (driver) => {
    driver.mockSandbox.setState({ status: "ready" });
    await driver.showSidebar();

    await driver.inputMagentaText("Read poem.txt");
    await driver.send();

    const r1 = await driver.mockAnthropic.awaitPendingStream();
    r1.respond({
      stopReason: "tool_use",
      text: "I'll read poem.txt for you.",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "get-file-1" as ToolRequestId,
            toolName: "get_file" as ToolName,
            input: { filePath: "./poem.txt" },
          },
        },
      ],
    });

    // Wait for tool to execute and the next request (with result) to be pending
    const r2 = await driver.mockAnthropic.awaitPendingStream();
    r2.respond({
      stopReason: "end_turn",
      text: "Done reading the poem.",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("Done reading the poem.");

    const originalThreadId = driver.magenta.chat.state.activeThreadId;

    // Fork at the assistant message that contains the tool_use
    await driver.pressOnDisplayMessage("I'll read poem.txt for you.", "F");

    await pollUntil(() => {
      if (driver.magenta.chat.state.activeThreadId === originalThreadId) {
        throw new Error("Still on original thread");
      }
    });

    const newThread = driver.magenta.chat.getActiveThread();
    const messages = newThread.agent.getState().messages;

    // Per the truncate algorithm, when forking at the assistant tool_use
    // message, we extend forward through the run of consecutive user
    // messages (tool_result + any trailing system_reminder messages),
    // so the assistant follow-up (e.g. "Done reading the poem.") is dropped.
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
    expect(messages[messages.length - 1].role).toBe("user");

    // The assistant follow-up "Done reading the poem." should be dropped.
    const containsDone = messages.some(
      (m) =>
        m.role === "assistant" &&
        m.content.some(
          (c) => c.type === "text" && c.text.includes("Done reading"),
        ),
    );
    expect(containsDone).toBe(false);

    // The assistant message at index 1 still has the tool_use.
    const assistantContent = messages[1].content;
    expect(assistantContent.some((c) => c.type === "tool_use")).toBe(true);

    // The tool_result is preserved in one of the user messages after.
    const hasToolResult = messages
      .slice(2)
      .some((m) => m.content.some((c) => c.type === "tool_result"));
    expect(hasToolResult).toBe(true);
  });
});

it("F on first user message keeps just that message and resets input", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("Hello");
    await driver.send();

    const r1 = await driver.mockAnthropic.awaitPendingStream();
    r1.respond({
      stopReason: "end_turn",
      text: "Hi there!",
      toolRequests: [],
    });

    const originalThreadId = driver.magenta.chat.state.activeThreadId;
    await driver.pressOnDisplayMessage("Hello", "F");

    await pollUntil(() => {
      if (driver.magenta.chat.state.activeThreadId === originalThreadId) {
        throw new Error("Still on original thread");
      }
    });

    const newThread = driver.magenta.chat.getActiveThread();
    const messages = newThread.agent.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");

    const inputBuffer = driver.getInputBuffer();
    const lines = await inputBuffer.getLines({
      start: 0 as never,
      end: -1 as never,
    });
    expect(lines).toEqual([""]);
  });
});

it("visual mode F includes selection as a markdown blockquote", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("What is the capital of France?");
    await driver.send();

    const r1 = await driver.mockAnthropic.awaitPendingStream();
    r1.respond({
      stopReason: "end_turn",
      text: "The capital of France is Paris.",
      toolRequests: [],
    });

    await driver.inputMagentaText("What about Germany?");
    await driver.send();

    const r2 = await driver.mockAnthropic.awaitPendingStream();
    r2.respond({
      stopReason: "end_turn",
      text: "The capital of Germany is Berlin.",
      toolRequests: [],
    });

    const originalThreadId = driver.magenta.chat.state.activeThreadId;

    await driver.pressOnDisplayMessageWithSelection(
      "The capital of Germany is Berlin.",
      "F",
      ["capital of Germany"],
    );

    await pollUntil(() => {
      if (driver.magenta.chat.state.activeThreadId === originalThreadId) {
        throw new Error("Still on original thread");
      }
    });

    const inputBuffer = driver.getInputBuffer();
    const lines = await inputBuffer.getLines({
      start: 0 as never,
      end: -1 as never,
    });
    expect(lines[0]).toBe("> capital of Germany");
    expect(lines[lines.length - 1]).toBe("");
  });
});

it("multi-line visual selection produces a multi-line quote", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("Tell me a haiku");
    await driver.send();

    const r1 = await driver.mockAnthropic.awaitPendingStream();
    r1.respond({
      stopReason: "end_turn",
      text: "Line one of the poem\nLine two of the poem",
      toolRequests: [],
    });

    const originalThreadId = driver.magenta.chat.state.activeThreadId;

    await driver.pressOnDisplayMessageWithSelection(
      "Line one of the poem",
      "F",
      ["Line one of the poem", "Line two of the poem"],
    );

    await pollUntil(() => {
      if (driver.magenta.chat.state.activeThreadId === originalThreadId) {
        throw new Error("Still on original thread");
      }
    });

    const inputBuffer = driver.getInputBuffer();
    const lines = await inputBuffer.getLines({
      start: 0 as never,
      end: -1 as never,
    });
    expect(lines[0]).toBe("> Line one of the poem");
    expect(lines[1]).toBe("> Line two of the poem");
    expect(lines[lines.length - 1]).toBe("");
  });
});
