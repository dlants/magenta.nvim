import { expect, it } from "vitest";
import { withDriver } from "../test/preamble";
import type { ToolRequestId } from "./toolManager";
import type { ToolName } from "./types";
import type { CompactReplacement } from "../providers/provider-types";
import { pollUntil } from "../utils/async";

it("agent-initiated compact without continuation", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // First message - creates checkpoint 000000
    await driver.inputMagentaText("Hello");
    await driver.send();

    const stream1 = await driver.mockAnthropic.awaitPendingStream();
    stream1.respond({
      stopReason: "end_turn",
      text: "Hi there",
      toolRequests: [],
    });

    // Second message - creates checkpoint 000001
    await driver.inputMagentaText("Compact please");
    await driver.send();

    const stream2 = await driver.mockAnthropic.awaitPendingStream();

    const replacements: CompactReplacement[] = [
      { to: "000000", summary: "Greeting exchange" },
    ];

    stream2.respond({
      stopReason: "tool_use",
      text: "Compacting",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "compact_no_cont" as ToolRequestId,
            toolName: "compact" as ToolName,
            input: { replacements },
          },
        },
      ],
    });

    await pollUntil(() => {
      const state = driver.magenta.chat.getActiveThread().agent.getState();
      if (state.status.type != "stopped")
        throw new Error(
          `expected agent to be stopped but it was ${JSON.stringify(state.status)}`,
        );
    });

    const state = driver.magenta.chat.getActiveThread().agent.getState();
    if (state.status.type != "stopped") throw new Error();
    expect(state.status.type).toBe("stopped");
    expect(state.status.stopReason).toBe("end_turn");

    // When agent-initiated compact completes without a continuation, the conversation stops
    const messages = driver.magenta.chat.getActiveThread().getMessages();
    expect(messages).toMatchSnapshot();
  });
});

it("agent-initiated compact with continuation", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // First message - creates checkpoint 000000
    await driver.inputMagentaText("Hello");
    await driver.send();

    const stream1 = await driver.mockAnthropic.awaitPendingStream();
    stream1.respond({
      stopReason: "end_turn",
      text: "Hi there",
      toolRequests: [],
    });

    // Second message - creates checkpoint 000001
    await driver.inputMagentaText("Compact and continue");
    await driver.send();

    const stream2 = await driver.mockAnthropic.awaitPendingStream();

    const replacements: CompactReplacement[] = [
      { to: "000000", summary: "Greeting exchange" },
    ];

    stream2.respond({
      stopReason: "tool_use",
      text: "Compacting",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "compact_cont" as ToolRequestId,
            toolName: "compact" as ToolName,
            input: {
              replacements,
              continuation: "Now let me continue with the next task.",
            },
          },
        },
      ],
    });

    // When agent-initiated compact completes, the conversation continues automatically
    const stream3 = await driver.mockAnthropic.awaitPendingStream();
    const messages = stream3.getProviderMessages();
    expect(messages).toMatchSnapshot();
  });
});

it("user-initiated @compact removes compact request and appends next prompt", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    // First message - creates checkpoint 000000
    await driver.inputMagentaText("Hello, let's have a conversation");
    await driver.send();

    const stream1 = await driver.mockAnthropic.awaitPendingStream();
    stream1.respond({
      stopReason: "end_turn",
      text: "Hello! I'm ready to chat.",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains("Hello! I'm ready to chat.");

    // Second message - creates checkpoint 000001
    await driver.inputMagentaText("Tell me about TypeScript");
    await driver.send();

    const stream2 = await driver.mockAnthropic.awaitPendingStream();
    stream2.respond({
      stopReason: "end_turn",
      text: "TypeScript is a typed superset of JavaScript.",
      toolRequests: [],
    });

    await driver.assertDisplayBufferContains(
      "TypeScript is a typed superset of JavaScript.",
    );

    // User initiates compact with @compact command
    // The text after @compact is the user's next prompt
    await driver.inputMagentaText("@compact Now help me with Python");
    await driver.send();

    // The agent receives the augmented message instructing it to compact
    const stream3 = await driver.mockAnthropic.awaitPendingStream();

    // Verify the agent received instructions to compact
    const messagesBeforeCompact = stream3.getProviderMessages();
    const lastUserMsg = messagesBeforeCompact
      .filter((m) => m.role === "user")
      .pop();
    const hasCompactInstruction = lastUserMsg?.content.some(
      (c) =>
        c.type === "text" &&
        c.text.includes("Use the compact tool") &&
        c.text.includes("Now help me with Python"),
    );
    expect(hasCompactInstruction).toBe(true);

    // Agent responds with compact tool
    const replacements: CompactReplacement[] = [
      { to: "000001", summary: "User greeted and asked about TypeScript" },
    ];

    stream3.respond({
      stopReason: "tool_use",
      text: "I'll compact the thread",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "compact_user" as ToolRequestId,
            toolName: "compact" as ToolName,
            input: { replacements },
          },
        },
      ],
    });

    // After compaction, the @compact user message AND agent's compact response
    // should be removed, and the user's next prompt should be appended
    const stream4 = await driver.mockAnthropic.awaitPendingStream();
    const messagesAfterCompact = stream4.getProviderMessages();
    expect(messagesAfterCompact).toMatchSnapshot();
  });
});
