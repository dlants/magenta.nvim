import { expect, it } from "vitest";
import type { MockStream } from "./providers/mock-anthropic-client.ts";
import type { NativeMessageIdx } from "./providers/provider-types.ts";
import { type Harness, withHarness } from "./test/harness.ts";
import type { Thread } from "./thread.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";

async function exchange(
  h: Harness,
  thread: Thread,
  msg: string,
  reply: string,
) {
  const done = h.send(thread, msg);
  (await h.nextStream()).respond({
    stopReason: "end_turn",
    text: reply,
    toolRequests: [],
  });
  await done;
}
const lastUserHasContextUpdate = (stream: MockStream) =>
  [...stream.getProviderMessages()]
    .reverse()
    .find((m) => m.role === "user")
    ?.content.some((c) => c.type === "context_update");
const files = { "/project/poem.txt": "moonlight\nover the sea\n" };
const userIdx = (thread: Thread, n: number) =>
  thread.getProviderMessages().filter((m) => m.role === "user")[n].content[0]
    .nativeMessageIdx;

it("rewind drops the target message and everything after, in place", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    await exchange(h, thread, "first", "one");
    await exchange(h, thread, "second", "two");
    await thread.rewind(userIdx(thread, 1));
    const texts = thread
      .getProviderMessages()
      .flatMap((m) => m.content)
      .map((c) => (c.type === "text" ? c.text : c.type));
    expect(texts.some((t) => t.includes("second"))).toBe(false);
    expect(texts.some((t) => t.includes("fork-notification"))).toBe(false);
    expect(thread.forkSeamIdx).toBeUndefined();
    expect(thread.state.type).toBe("idle");
  }));

it("rewind forgets context delivered by the dropped turns", () =>
  withHarness({ files }, async (h) => {
    const { thread } = await h.createRoot();
    await exchange(h, thread, "Start", "Ready.");
    await exchange(h, thread, "Now read @file:poem.txt", "Read it.");
    const dropped = userIdx(thread, 1);
    await thread.rewind(dropped);
    expect(thread.getContextDelivery(dropped)).toBeUndefined();
    void h.send(thread, "Continue");
    expect(lastUserHasContextUpdate(await h.nextStream())).toBe(true);
  }));

it("rewind at a tool result strips the preceding tool_use", () =>
  withHarness({ files }, async (h) => {
    const { thread } = await h.createRoot();
    const done = h.send(thread, "Read poem.txt");
    (await h.nextStream()).respond({
      stopReason: "tool_use",
      text: "Reading poem.txt",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "get-file-1" as ToolRequestId,
            toolName: "get_files" as ToolName,
            input: { files: [{ filePath: "./poem.txt" }] },
          },
        },
      ],
    });
    (await h.nextStream()).respond({
      stopReason: "end_turn",
      text: "Done reading.",
      toolRequests: [],
    });
    await done;
    const resultIdx = thread
      .getProviderMessages()
      .flatMap((m) => m.content)
      .find((c) => c.type === "tool_result")?.nativeMessageIdx;
    if (resultIdx === undefined) throw new Error("no tool_result");
    await thread.rewind(resultIdx);
    const blocks = thread.getProviderMessages().flatMap((m) => m.content);
    expect(blocks.some((c) => c.type === "tool_use")).toBe(false);
    expect(blocks.some((c) => c.type === "tool_result")).toBe(false);
    expect(
      blocks.some((c) => c.type === "text" && c.text === "Reading poem.txt"),
    ).toBe(true);
    void h.send(thread, "Continue");
    const stream = await h.nextStream();
    expect(JSON.stringify(stream.params.messages)).not.toContain("get-file-1");
  }));

it("rewind while streaming aborts the submission first", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    await exchange(h, thread, "first", "one");
    const pending = h.send(thread, "second");
    await h.nextStream();
    await thread.rewind(userIdx(thread, 1));
    await pending;
    expect(thread.state.type).toBe("idle");
    expect(thread.getProviderMessages()).toHaveLength(2);
  }));

it("rewind to the start empties the conversation", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    await exchange(h, thread, "first", "one");
    await thread.rewind(0 as NativeMessageIdx);
    expect(thread.getProviderMessages()).toHaveLength(0);
    void h.send(thread, "again");
    const stream = await h.nextStream();
    expect(JSON.stringify(stream.params.messages)).toContain("again");
  }));
