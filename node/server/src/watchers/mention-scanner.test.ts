import { expect, it } from "vitest";
import type {
  NativeMessageIdx,
  ProviderMessage,
  ProviderMessageContent,
} from "../providers/provider-types.ts";
import { pollUntil } from "../utils/async.ts";
import { MentionScanner } from "./mention-scanner.ts";

const idx = (n: number) => n as NativeMessageIdx;
const text = (t: string, n: number): ProviderMessageContent => ({
  type: "text",
  text: t,
  nativeMessageIdx: idx(n),
});
function scannerOver(initial: ProviderMessage[]) {
  let messages = initial;
  const scanned: string[] = [];
  const scanner = new MentionScanner(
    () => messages,
    (texts) => {
      scanned.push(...texts);
      return Promise.resolve();
    },
  );
  return {
    set(next: ProviderMessage[]) {
      messages = next;
      scanner.schedule();
    },
    scanned,
  };
}
it("sends user and assistant text, newlines intact", async () => {
  const s = scannerOver([]);
  s.set([
    { role: "user", content: [text("see a\nb", 0)] },
    { role: "assistant", content: [text("also c", 1)] },
  ]);
  await pollUntil(() => expect(s.scanned).toEqual(["see a\nb", "also c"]));
});
it("skips injected, reasoning and search blocks and citations", async () => {
  const s = scannerOver([]);
  s.set([
    {
      role: "user",
      content: [
        { type: "context_update", text: "ctx", nativeMessageIdx: idx(0) },
        { type: "system_reminder", text: "rem", nativeMessageIdx: idx(0) },
        text("keep", 0),
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "think",
          nativeMessageIdx: idx(1),
        },
        {
          type: "text",
          text: "cited",
          citations: [
            {
              type: "web_search_citation",
              cited_text: "cite",
              encrypted_index: "",
              title: "t",
              url: "u",
            },
          ],
          nativeMessageIdx: idx(1),
        } as ProviderMessageContent,
      ],
    },
  ]);
  await pollUntil(() => expect(s.scanned).toEqual(["keep", "cited"]));
  await new Promise((r) => setTimeout(r, 10));
  expect(s.scanned).toEqual(["keep", "cited"]);
});
it("sends only blocks appended to a scanned message", async () => {
  const first = text("one", 0);
  const s = scannerOver([]);
  s.set([{ role: "user", content: [first] }]);
  await pollUntil(() => expect(s.scanned).toEqual(["one"]));
  s.set([{ role: "user", content: [first, text("two", 0)] }]);
  await pollUntil(() => expect(s.scanned).toEqual(["one", "two"]));
});
it("batches at 256KB, truncates strings to 64KB, drops empty strings", async () => {
  const calls: string[][] = [];
  const scanner = new MentionScanner(
    () => [
      {
        role: "user",
        content: [
          text("", 0),
          ...Array.from({ length: 5 }, (_, i) =>
            text(String(i).repeat(100 * 1024), 0),
          ),
        ],
      },
    ],
    (texts) => {
      calls.push(texts);
      return Promise.resolve();
    },
  );
  scanner.schedule();
  await pollUntil(() => expect(calls.length).toBe(2));
  const K = 64 * 1024;
  expect(calls.map((c) => c.map((t) => t.length))).toEqual([[K, K, K, K], [K]]);
  expect(calls.flat().map((t) => t[0])).toEqual(["0", "1", "2", "3", "4"]);
});
