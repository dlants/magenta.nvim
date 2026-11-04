import { expect, it } from "vitest";
import type {
  NativeMessageIdx,
  ProviderMessage,
  ProviderMessageContent,
} from "../providers/provider-types.ts";
import { pollUntil } from "../utils/async.ts";
import { MentionScanner } from "./mention-scanner.ts";
import type { WatcherName } from "./protocol.ts";
import type { WatcherTriggerMatcher } from "./watcher-registry.ts";

const W = "w" as WatcherName;
const matchers: WatcherTriggerMatcher[] = [
  { watcher: W, regex: /key-(\d+)/g, keyGroup: 1 },
];
const idx = (n: number) => n as NativeMessageIdx;
const text = (t: string, n: number): ProviderMessageContent => ({
  type: "text",
  text: t,
  nativeMessageIdx: idx(n),
});

function scannerOver(initial: ProviderMessage[]) {
  let messages = initial;
  const scanner = new MentionScanner(
    () => messages,
    () => matchers,
    () => {},
  );
  return {
    scanner,
    set(next: ProviderMessage[]) {
      messages = next;
      scanner.schedule();
    },
    keys: () => scanner.mentioned.map((r) => r.key).sort(),
  };
}
const settle = (s: { keys: () => string[] }, expected: string[]) =>
  pollUntil(() => expect(s.keys()).toEqual(expected));

it("finds keys in user and assistant text, several per string", async () => {
  const s = scannerOver([]);
  s.set([
    { role: "user", content: [text("see key-1 and key-2", 0)] },
    { role: "assistant", content: [text("also key-3", 1)] },
  ]);
  await settle(s, ["1", "2", "3"]);
});

it("ignores keys that only appear in injected blocks", async () => {
  const s = scannerOver([]);
  s.set([
    {
      role: "user",
      content: [
        { type: "context_update", text: "key-8", nativeMessageIdx: idx(0) },
        { type: "system_reminder", text: "key-9", nativeMessageIdx: idx(0) },
        text("key-1", 0),
      ],
    },
  ]);
  await settle(s, ["1"]);
  await new Promise((r) => setTimeout(r, 10));
  expect(s.keys()).toEqual(["1"]);
});

it("picks up blocks appended to a scanned message without rescanning it", async () => {
  const first = text("key-1", 0);
  const s = scannerOver([]);
  s.set([{ role: "user", content: [first] }]);
  await settle(s, ["1"]);
  // Mutating an already-scanned block is invisible: only new blocks are read.
  (first as { text: string }).text = "key-5";
  s.set([{ role: "user", content: [first, text("key-2", 0)] }]);
  await settle(s, ["1", "2"]);
});
