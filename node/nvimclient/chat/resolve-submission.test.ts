import { pendingMessage } from "@magenta/server";
import { describe, expect, it } from "vitest";
import { type PreparedNvimContext, resolveSubmission } from "./session-host.ts";

const fileContent = { type: "text" as const, text: "contents of foo.ts" };
const context = {
  commandRegistry: {
    processMessage: async (text: string) => ({
      processedText: text,
      additionalContent: text.includes("@file:foo.ts") ? [fileContent] : [],
      reminders: [],
    }),
  },
  environment: { cwd: "/", homeDir: "/" },
} as unknown as PreparedNvimContext;
const resolve = (text: string, canCompact: boolean) =>
  resolveSubmission(
    pendingMessage(text),
    context,
    () => ({}) as never,
    canCompact,
  );

describe("resolveSubmission", () => {
  it("expands the rest of an @compact into the compact handoff", async () => {
    expect(await resolve("@compact look at @file:foo.ts", true)).toEqual({
      type: "compact",
      prompt: {
        content: [{ type: "text", text: "look at @file:foo.ts" }, fileContent],
        reminders: [],
      },
    });
  });

  it("sends @compact as ordinary text in a compact thread", async () => {
    expect(await resolve("@compact", false)).toEqual({
      type: "send",
      prompt: { content: [{ type: "text", text: "@compact" }], reminders: [] },
    });
  });
});
