import { describe, expect, it, vi } from "vitest";
import { awaitNextStream, createTestAgent } from "./test-helpers.ts";
import type { ToolInvocationState } from "./thread-api.ts";
import { activityLabel, streamingBlock } from "./thread-state.ts";
import type { ToolOutcome } from "./tool-loop.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";
import { Defer, pollUntil } from "./utils/async.ts";

describe("ToolLoop lifecycle and progress", () => {
  it("owns streaming and tool progress until the turn settles", async () => {
    const entered = new Defer<void>();
    const tools = new Defer<ToolOutcome>();
    let publish!: (state: ToolInvocationState) => void;
    const { agent, mockClient } = createTestAgent({
      executeTools: (_requests, publishTools) => {
        publish = publishTools;
        entered.resolve();
        return tools.promise;
      },
    });
    const turn = agent.send([
      {
        type: "text",
        text: "read the file",
      },
    ]);
    const stream = await mockClient.awaitStream();
    expect(turn.activity).toMatchObject({ type: "streaming" });
    expect(turn.activity).not.toHaveProperty("send");
    stream.emitEvent({
      type: "content_block_start",
      index: stream.nextBlockIndex(),
      content_block: { type: "text", text: "looking", citations: null },
    });
    await pollUntil(() => {
      expect(streamingBlock(agent.state)).toEqual({
        type: "text",
        text: "looking",
      });
      return true;
    });
    stream.emitEvent({ type: "content_block_stop", index: 0 });
    await pollUntil(() => {
      expect(streamingBlock(agent.state)).toBeUndefined();
      return true;
    });
    stream.streamToolUse("read" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/test.txt" }],
    });
    stream.finishResponse("tool_use");
    await entered.promise;
    expect(turn.activity).toMatchObject({
      type: "running_tools",
      tools: { type: "pending" },
    });
    const running: ToolInvocationState = {
      type: "running",
      activeTools: new Map(),
    };
    publish(running);
    expect(turn.activity).toMatchObject({
      type: "running_tools",
      tools: running,
    });
    tools.resolve({ type: "continue", results: new Map() });
    const continuation = await awaitNextStream(mockClient, stream);
    expect(turn.activity).toMatchObject({
      type: "streaming",
      block: undefined,
    });
    publish(running);
    expect(turn.activity.type).toBe("streaming");
    continuation.streamText("done");
    continuation.finishResponse("end_turn");
    expect(await turn.promise).toEqual({
      type: "completed",
      stopReason: "end_turn",
    });
    expect(agent.state).toEqual({
      type: "idle",
      lastResult: { type: "completed", stopReason: "end_turn" },
    });
  });

  it("retains tool activity while aborting and starts the next turn clean", async () => {
    const entered = new Defer<void>();
    const tools = new Defer<ToolOutcome>();
    const abort = vi.fn();
    const { agent, mockClient } = createTestAgent({
      executeTools: (_requests, _publish, abortSignal) => {
        abortSignal.addEventListener("abort", abort);
        entered.resolve();
        return tools.promise;
      },
    });
    const first = agent.send([
      {
        type: "text",
        text: "read",
      },
    ]);
    const stream = await mockClient.awaitStream();
    stream.streamToolUse("read" as ToolRequestId, "get_files" as ToolName, {
      files: [{ filePath: "/tmp/test.txt" }],
    });
    stream.finishResponse("tool_use");
    await entered.promise;
    expect(first.activity).toMatchObject({
      type: "running_tools",
    });
    expect(first.activity).not.toHaveProperty("send");
    first.abort();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(first.aborting).toBe(true);
    expect(activityLabel(agent.state)).toBe("running_tools");
    tools.resolve({ type: "aborted", results: new Map() });
    expect(await first.promise).toEqual({ type: "aborted" });
    expect(first.activity).toEqual({ type: "preparing" });
    first.abort();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(activityLabel(agent.state)).toBe("idle");

    const second = agent.send([
      {
        type: "text",
        text: "try again",
      },
    ]);
    const next = await awaitNextStream(mockClient, stream);
    expect(second.aborting).toBe(false);
    next.streamText("done");
    next.finishResponse("end_turn");
    expect(await second.promise).toEqual({
      type: "completed",
      stopReason: "end_turn",
    });
  });

  it("aborts during request preparation without issuing inference", async () => {
    const entered = new Defer<void>();
    const gate = new Defer<void>();
    const { agent, mockClient } = createTestAgent({
      onBeforeRequest: async () => {
        entered.resolve();
        await gate.promise;
        return [];
      },
    });
    const turn = agent.send([
      {
        type: "text",
        text: "hello",
      },
    ]);
    await entered.promise;
    turn.abort();
    expect(turn.aborting).toBe(true);
    gate.resolve();
    expect(await turn.promise).toEqual({ type: "aborted" });
    expect(mockClient.streams).toHaveLength(0);
  });

  it("aborts the streaming request through its turn handle", async () => {
    const { agent, mockClient } = createTestAgent();
    const turn = agent.send([
      {
        type: "text",
        text: "hello",
      },
    ]);
    const stream = await mockClient.awaitStream();
    turn.abort();
    await pollUntil(() => {
      expect(stream.aborted).toBe(true);
      return true;
    });
    expect(await turn.promise).toEqual({ type: "aborted" });
    expect(agent.state).toEqual({
      type: "idle",
      lastResult: { type: "aborted" },
    });
  });
});
