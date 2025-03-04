import { extractMountTree, withNvimClient } from "../test/preamble.ts";
import * as Chat from "./chat.ts";
import { type ToolRequestId } from "../tools/toolManager.ts";
import { createApp } from "../tea/tea.ts";
import { describe, expect, it } from "vitest";
import { pos } from "../tea/view.ts";
import { NvimBuffer, type Line } from "../nvim/buffer.ts";

describe("tea/chat.spec.ts", () => {
  it("chat render and a few updates", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      const chatModel = Chat.init({ nvim, lsp: undefined as any });
      const model = chatModel.initModel();

      const app = createApp({
        nvim,
        initialModel: model,
        update: (model, msg) => chatModel.update(model, msg, { nvim }),
        View: chatModel.view,
        suppressThunks: true,
      });

      const mountedApp = await app.mount({
        nvim,
        buffer,
        startPos: pos(0, 0),
        endPos: pos(-1, -1),
      });

      await mountedApp.waitForRender();

      expect(
        await buffer.getLines({ start: 0, end: -1 }),
        "initial render of chat works",
      ).toEqual(Chat.LOGO.split("\n") as Line[]);

      app.dispatch({
        type: "add-message",
        role: "user",
        content: "Can you look at my list of buffers?",
      });
      await mountedApp.waitForRender();

      app.dispatch({
        type: "stream-response",
        text: "Sure, let me use the list_buffers tool.",
      });
      await mountedApp.waitForRender();

      app.dispatch({
        type: "init-tool-use",
        request: {
          status: "ok",
          value: {
            id: "request-id" as ToolRequestId,
            input: {},
            name: "list_buffers",
          },
        },
      });
      await mountedApp.waitForRender();

      expect(
        await buffer.getLines({ start: 0, end: -1 }),
        "in-progress render is as expected",
      ).toEqual([
        "# user:",
        "Can you look at my list of buffers?",
        "",
        "# assistant:",
        "Sure, let me use the list_buffers tool.",
        "⚙️ Grabbing buffers...",
        "",
        "Stopped (end_turn)",
      ] as Line[]);

      expect(
        await extractMountTree(mountedApp.getMountedNode()),
      ).toMatchSnapshot();

      app.dispatch({
        type: "tool-manager-msg",
        msg: {
          type: "tool-msg",
          id: "request-id" as ToolRequestId,
          msg: {
            type: "list_buffers",
            msg: {
              type: "finish",
              result: {
                status: "ok",
                value: "some buffer content",
              },
            },
          },
        },
      });
      await mountedApp.waitForRender();

      expect(
        await buffer.getLines({ start: 0, end: -1 }),
        "finished render is as expected",
      ).toEqual([
        "# user:",
        "Can you look at my list of buffers?",
        "",
        "# assistant:",
        "Sure, let me use the list_buffers tool.",
        "✅ Finished getting buffers.",
        "",
        "Stopped (end_turn)",
      ] as Line[]);
    });
  });

  it("chat clear", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      const chatModel = Chat.init({ nvim, lsp: undefined as any });
      const model = chatModel.initModel();

      const app = createApp({
        nvim,
        initialModel: model,
        update: (model, msg) => chatModel.update(model, msg, { nvim }),
        View: chatModel.view,
        suppressThunks: true,
      });

      const mountedApp = await app.mount({
        nvim,
        buffer,
        startPos: pos(0, 0),
        endPos: pos(-1, -1),
      });

      await mountedApp.waitForRender();

      expect(
        await buffer.getLines({ start: 0, end: -1 }),
        "initial render of chat works",
      ).toEqual(Chat.LOGO.split("\n") as Line[]);

      app.dispatch({
        type: "add-message",
        role: "user",
        content: "Can you look at my list of buffers?",
      });
      await mountedApp.waitForRender();

      app.dispatch({
        type: "stream-response",
        text: "Sure, let me use the list_buffers tool.",
      });
      await mountedApp.waitForRender();

      expect(
        await buffer.getLines({ start: 0, end: -1 }),
        "in-progress render is as expected",
      ).toEqual([
        "# user:",
        "Can you look at my list of buffers?",
        "",
        "# assistant:",
        "Sure, let me use the list_buffers tool.",
        "",
        "Stopped (end_turn)",
      ] as Line[]);

      app.dispatch({
        type: "clear",
      });
      await mountedApp.waitForRender();

      expect(
        await buffer.getLines({ start: 0, end: -1 }),
        "finished render is as expected",
      ).toEqual(Chat.LOGO.split("\n") as Line[]);
    });
  });
});
