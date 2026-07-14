import {
  AutoCompactSupervisor,
  SubagentSupervisor,
  type ThreadId,
  type ToolName,
  type ToolRequestId,
} from "@magenta/core";
import { expect, it } from "vitest";
import { withDriver } from "../test/preamble.ts";

it("root/user threads get an AutoCompactSupervisor", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    const thread = driver.magenta.chat.getActiveThread();

    expect(
      thread.supervisors.some((s) => s instanceof AutoCompactSupervisor),
    ).toBe(true);
    expect(
      thread.supervisors.some((s) => s instanceof SubagentSupervisor),
    ).toBe(false);
  });
});

it("subagent threads get both SubagentSupervisor and AutoCompactSupervisor", async () => {
  await withDriver({}, async (driver) => {
    await driver.showSidebar();

    await driver.inputMagentaText("Use spawn_subagents to do a task.");
    await driver.send();

    const stream1 =
      await driver.mockAnthropic.awaitPendingStreamWithText("spawn_subagents");

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

    // Wait for the child subagent stream to start.
    await driver.mockAnthropic.awaitPendingStreamWithText("Do the task");

    const chat = driver.magenta.chat;
    const childThreadId = Object.keys(chat.threadWrappers).find((id) => {
      const wrapper = chat.threadWrappers[id as ThreadId];
      return wrapper?.parentThreadId !== undefined;
    }) as ThreadId | undefined;
    expect(childThreadId).toBeDefined();

    const childWrapper = chat.threadWrappers[childThreadId!];
    if (childWrapper.state !== "initialized")
      throw new Error("Expected initialized child thread");
    const supervisors = childWrapper.thread.supervisors;

    expect(supervisors.some((s) => s instanceof SubagentSupervisor)).toBe(true);
    expect(supervisors.some((s) => s instanceof AutoCompactSupervisor)).toBe(
      true,
    );
  });
});
