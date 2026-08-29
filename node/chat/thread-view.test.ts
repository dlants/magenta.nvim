import type { AgentPhase } from "@magenta/core";
import { describe, expect, it } from "vitest";
import { type Line, NvimBuffer } from "../nvim/buffer.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import { mountView, pos } from "../tea/view.ts";
import { withNvimClient } from "../test/preamble.ts";
import { renderStatus } from "./thread-view.ts";

async function renderStatusToString(agentPhase: AgentPhase): Promise<string> {
  let text = "";
  await withNvimClient(async (nvim) => {
    const buffer = await NvimBuffer.create(false, true, nvim);
    await buffer.setOption("modifiable", false);
    await mountView({
      view: () =>
        renderStatus(
          agentPhase,
          { type: "normal" },
          undefined,
          undefined,
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

describe("thread-view renderStatus streaming", () => {
  it("shows no waiting timer when last event was recent", async () => {
    const now = new Date();
    const text = await renderStatusToString({
      type: "streaming",
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
});
