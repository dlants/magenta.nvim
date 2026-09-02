import type {
  LoopActivity,
  LoopEpoch,
  RestResult,
  SendResult,
  ThreadLoopState,
} from "@magenta/core";
import { describe, expect, it } from "vitest";
import { type Line, NvimBuffer } from "../nvim/buffer.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import { mountView, pos } from "../tea/view.ts";
import { withNvimClient } from "../test/preamble.ts";
import { renderStatus } from "./thread-view.ts";

async function renderStatusToString(
  state: ThreadLoopState | Extract<LoopActivity, { type: "streaming" }>,
  lastTurnResult?: RestResult,
): Promise<string> {
  const loopState: ThreadLoopState =
    state.type === "streaming"
      ? {
          type: "running",
          epoch: 1 as LoopEpoch,
          activity: state,
          aborting: false,
        }
      : state;
  let text = "";
  await withNvimClient(async (nvim) => {
    const buffer = await NvimBuffer.create(false, true, nvim);
    await buffer.setOption("modifiable", false);
    await mountView({
      view: () =>
        renderStatus(
          loopState,
          undefined,
          lastTurnResult,
          undefined,
          () => {},
          undefined,
        ),
      props: {},
      mount: {
        nvim,
        buffer,
        startPos: pos(0, 0),
        endPos: pos(0, 0),
      },
    });
    const lines = await buffer.getLines({
      start: 0 as Row0Indexed,
      end: 100 as Row0Indexed,
    });
    text = (lines as Line[]).join("\n");
  });
  return text;
}

/** The activities carry the submission they belong to; these render-only
 * tests never observe it. */
const neverSettles = new Promise<SendResult>(() => {});

describe("thread-view renderStatus streaming", () => {
  it("shows no waiting timer when last event was recent", async () => {
    const now = new Date();
    const text = await renderStatusToString({
      type: "streaming",
      send: neverSettles,
      startedAt: now,
      lastEventTime: new Date(now.getTime() - 1000),
      block: undefined,
      retry: undefined,
    });
    expect(text).toContain("Streaming response");
    expect(text).not.toContain("waiting");
  });

  it("shows a waiting timer after >3s of dead air", async () => {
    const now = new Date();
    const text = await renderStatusToString({
      type: "streaming",
      send: neverSettles,
      startedAt: new Date(now.getTime() - 4000),
      lastEventTime: new Date(now.getTime() - 4000),
      block: undefined,
      retry: undefined,
    });
    expect(text).toContain("Streaming response");
    expect(text).toMatch(/waiting \ds/);
  });

  it("shows a retry countdown with attempt and error reason", async () => {
    const now = new Date();
    const text = await renderStatusToString({
      type: "streaming",
      send: neverSettles,
      startedAt: new Date(now.getTime() - 2000),
      lastEventTime: new Date(now.getTime() - 2000),
      block: undefined,
      retry: {
        attempt: 2,
        nextRetryAt: new Date(now.getTime() + 5000),
        error: new Error("API is temporarily overloaded"),
      },
    });
    expect(text).toContain("Retrying in");
    expect(text).toContain("attempt 2");
    expect(text).toContain("API is temporarily overloaded");
  });

  it("renders the preparing activity", async () => {
    const text = await renderStatusToString({
      type: "running",
      epoch: 1 as LoopEpoch,
      activity: { type: "preparing" },
      aborting: false,
    });
    expect(text).toContain("Preparing...");
  });

  it("renders aborting ahead of whatever the loop is still doing", async () => {
    const now = new Date();
    const text = await renderStatusToString({
      type: "running",
      epoch: 1 as LoopEpoch,
      activity: {
        type: "streaming",
        send: neverSettles,
        startedAt: now,
        lastEventTime: now,
        block: undefined,
        retry: undefined,
      },
      aborting: true,
    });
    expect(text).toContain("Aborting...");
    expect(text).not.toContain("Streaming response");
  });

  it("renders an empty submission as a normal stop", async () => {
    const text = await renderStatusToString(
      { type: "idle", lastResult: { type: "empty" } },
      { type: "empty" },
    );
    expect(text).toContain("Stopped (end_turn)");
  });
});
