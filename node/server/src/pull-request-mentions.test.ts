import { describe, expect, it, vi } from "vitest";
import type {
  NativeMessageIdx,
  ProviderMessage,
} from "./providers/provider-types.ts";
import { PullRequestMentionScanner } from "./pull-request-mentions.ts";

const idx = (n: number) => n as NativeMessageIdx;

describe("PullRequestMentionScanner", () => {
  it("finds links in text and tool results, skipping injected context, and scans appended blocks", async () => {
    let messages: ProviderMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "see https://github.com/acme/widgets/pull/12\nthanks",
            nativeMessageIdx: idx(0),
          },
          {
            type: "context_update",
            text: "https://github.com/acme/widgets/pull/99",
            nativeMessageIdx: idx(0),
          },
        ],
      },
    ];
    const onChanged = vi.fn();
    const scanner = new PullRequestMentionScanner(() => messages, onChanged);
    scanner.schedule();
    await vi.waitFor(() =>
      expect(scanner.mentionedPullRequests).toEqual([
        "https://github.com/acme/widgets/pull/12",
      ]),
    );

    const appended = [...messages[0].content];
    appended.push({
      type: "tool_result",
      id: "t1" as never,
      result: {
        status: "ok",
        value: [
          { type: "text", text: "out: https://github.com/acme/gears/pull/3" },
        ],
      },
      nativeMessageIdx: idx(0),
    });
    scanner.schedule();
    expect(onChanged).toHaveBeenCalledTimes(1);
    messages = [{ role: "user", content: appended }];
    scanner.schedule();
    await vi.waitFor(() =>
      expect(scanner.mentionedPullRequests).toEqual([
        "https://github.com/acme/widgets/pull/12",
        "https://github.com/acme/gears/pull/3",
      ]),
    );
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});
