import type Anthropic from "@anthropic-ai/sdk";
import { expect, it } from "vitest";
import type { MockStream } from "./providers/mock-anthropic-client.ts";
import { type Harness, withHarness } from "./test/harness.ts";
import type { Thread } from "./thread.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";

type TextBlockParam = Anthropic.Messages.TextBlockParam;

const SKILL_WITH_REMINDER =
  "# Skill\n\n<system_reminder>\nalways pet the cat\n</system_reminder>\n";
const files = {
  "/project/poem.txt": "roses are red\n",
  "/project/skill.md": SKILL_WITH_REMINDER,
};

function lastMessage(stream: MockStream): Anthropic.MessageParam {
  const message = stream.messages.at(-1);
  if (!message) throw new Error("no messages");
  return message;
}

function reminders(message: Anthropic.MessageParam): TextBlockParam[] {
  if (typeof message.content === "string") return [];
  return message.content.filter(
    (c): c is TextBlockParam =>
      c.type === "text" && c.text.includes("<system-reminder>"),
  );
}

function getFiles(id: string, filePath: string) {
  return {
    status: "ok" as const,
    value: {
      id: id as ToolRequestId,
      toolName: "get_files" as ToolName,
      input: { files: [{ filePath }] },
    },
  };
}

/** Finish a high-output turn so the standing reminder fires on the next send. */
async function arm(h: Harness, thread: Thread): Promise<void> {
  const done = h.send(thread, "warm up");
  (await h.nextStream()).respond({
    stopReason: "end_turn",
    text: "warmed up",
    toolRequests: [],
    usage: { inputTokens: 10, outputTokens: 5000 },
  });
  await done;
}

it("the opening request of a thread carries the standing reminder", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "Hello");
    expect(reminders(lastMessage(await h.nextStream()))).toHaveLength(1);
  }));

it("root thread gets the base reminder past the token interval", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    await arm(h, thread);
    void h.send(thread, "Hello");
    const message = lastMessage(await h.nextStream());
    expect(message.role).toBe("user");
    const [reminder] = reminders(message);
    expect(reminder?.text).toContain("Remember the skills");
    expect(reminder?.text).not.toContain("yield_to_parent");
    expect(reminder?.text).not.toContain("notes/");
    expect(reminder?.text).not.toContain("plans/");
  }));

it("auto-respond messages include the reminder after the tool result", () =>
  withHarness({ files }, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "Use a tool");
    (await h.nextStream()).respond({
      stopReason: "tool_use",
      text: "I'll use get_file",
      toolRequests: [getFiles("tool_1", "./poem.txt")],
    });
    const message = lastMessage(await h.nextStream());
    if (typeof message.content === "string") throw new Error("expected blocks");
    const blocks = message.content;
    const toolIdx = blocks.findIndex((b) => b.type === "tool_result");
    const reminderIdx = blocks.findIndex(
      (b) => b.type === "text" && b.text.includes("<system-reminder>"),
    );
    expect(toolIdx).toBeGreaterThan(-1);
    expect(reminderIdx).toBeGreaterThan(toolIdx);
  }));

it("auto-respond skips the reminder below the token threshold, then includes it once enough accumulate", () =>
  withHarness({ files }, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "Use tools");
    (await h.nextStream()).respond({
      stopReason: "tool_use",
      text: "first",
      toolRequests: [getFiles("tool_1", "./poem.txt")],
      usage: { inputTokens: 100, outputTokens: 100 },
    });
    const second = await h.nextStream();
    expect(reminders(lastMessage(second))).toHaveLength(0);
    second.respond({
      stopReason: "tool_use",
      text: "second",
      toolRequests: [getFiles("tool_2", "./poem.txt")],
      usage: { inputTokens: 100, outputTokens: 2500 },
    });
    expect(reminders(lastMessage(await h.nextStream()))).toHaveLength(1);
  }));

it("the standing reminder is gated by the token interval, not by user turns", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    const turn = async (text: string, outputTokens: number) => {
      const done = h.send(thread, text);
      const stream = await h.nextStream();
      const count = reminders(lastMessage(stream)).length;
      stream.respond({
        stopReason: "end_turn",
        text: "ok",
        toolRequests: [],
        usage: { inputTokens: 10, outputTokens },
      });
      await done;
      return count;
    };
    expect(await turn("First", 100)).toBe(1);
    expect(await turn("Second", 5000)).toBe(0);
    expect(await turn("Third", 0)).toBe(1);
  }));

it("the standing reminder sits after context updates and before the user's text", () =>
  withHarness({ files }, async (h) => {
    const { thread } = await h.createRoot();
    await arm(h, thread);
    void h.send(thread, "@file:poem.txt Hello");
    const message = lastMessage(await h.nextStream());
    if (typeof message.content === "string") throw new Error("expected blocks");
    const texts = message.content.map((b) => (b.type === "text" ? b.text : ""));
    expect(texts[0]).toContain("poem.txt");
    expect(texts[1]).toContain("<system-reminder>");
    expect(texts[2]).toContain("Hello");
  }));

it("auto-respond combines the standing and bash reminders into a single block", () =>
  withHarness(
    { shell: { "long-output": { stdout: "X".repeat(15000) } } },
    async (h) => {
      const { thread } = await h.createRoot();
      void h.send(thread, "Run a long command");
      (await h.nextStream()).respond({
        stopReason: "tool_use",
        text: "running",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "tool_long" as ToolRequestId,
              toolName: "bash_command" as ToolName,
              input: { command: "long-output" },
            },
          },
        ],
        usage: { inputTokens: 1000, outputTokens: 5000 },
      });
      const blocks = reminders(lastMessage(await h.nextStream()));
      expect(blocks).toHaveLength(1);
      const text = blocks[0]?.text ?? "";
      expect(text.match(/<system-reminder>/g)).toHaveLength(1);
      expect(text).toContain("Remember the skills");
      expect(text).toContain("bash_summarizer");
    },
  ));

it("reading a markdown file with a system_reminder block folds it into standing reminders", () =>
  withHarness({ files }, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "Use a skill");
    (await h.nextStream()).respond({
      stopReason: "tool_use",
      text: "reading the skill",
      toolRequests: [getFiles("tool_1", "./skill.md")],
      usage: { inputTokens: 100, outputTokens: 5000 },
    });
    const [reminder] = reminders(lastMessage(await h.nextStream()));
    expect(reminder?.text).toContain("always pet the cat");
  }));

it("a markdown context file's block is active while in context", () =>
  withHarness({ files }, async (h) => {
    const { thread } = await h.createRoot();
    await arm(h, thread);
    void h.send(thread, "@file:skill.md Hello");
    const [reminder] = reminders(lastMessage(await h.nextStream()));
    expect(reminder?.text).toContain("always pet the cat");
  }));
