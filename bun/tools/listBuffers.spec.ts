import * as ListBuffers from "./listBuffers.ts";
import { type ToolRequestId } from "./toolManager.ts";
import { createApp } from "../tea/tea.ts";
import { describe, it, expect } from "bun:test";
import { pos } from "../tea/view.ts";
import { NvimBuffer } from "../nvim/buffer.ts";
import { withNvimClient } from "../test/preamble.ts";
import { withDriver } from "../test/preamble";
import { pollUntil } from "../utils/async.ts";

describe("bun/tools/listBuffers.spec.ts", () => {
  it("listBuffers end-to-end", async () => {
    await withDriver(async (driver) => {
      await driver.editFile("bun/test/fixtures/poem.txt");
      await driver.editFile("bun/test/fixtures/poem2.txt");
      await driver.showSidebar();

      await driver.assertWindowCount(3);

      await driver.inputMagentaText(`Try listing some buffers`);
      await driver.send();

      const toolRequestId = "id" as ToolRequestId;
      await driver.mockAnthropic.respond({
        stopReason: "tool_use",
        text: "ok, here goes",
        toolRequests: [
          {
            status: "ok",
            value: {
              type: "tool_use",
              id: toolRequestId,
              name: "list_buffers",
              input: {},
            },
          },
        ],
      });

      const result = await pollUntil(() => {
        const state = driver.magenta.chatApp.getState();
        if (state.status != "running") {
          throw new Error(`app crashed`);
        }

        const toolWrapper = state.model.toolManager.toolWrappers[toolRequestId];
        if (!toolWrapper) {
          throw new Error(
            `could not find toolWrapper with id ${toolRequestId}`,
          );
        }

        if (toolWrapper.model.state.state != "done") {
          throw new Error(`Request not done`);
        }

        return toolWrapper.model.state.result;
      });

      expect(result).toEqual({
        tool_use_id: toolRequestId,
        type: "tool_result",
        content: `bun/test/fixtures/poem.txt\nactive bun/test/fixtures/poem2.txt`,
      });
    });
  });

  it("render the listBuffers tool.", async () => {
    await withNvimClient(async (nvim) => {
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("modifiable", false);

      const [model, _thunk] = ListBuffers.initModel(
        {
          type: "tool_use",
          id: "request_id" as ToolRequestId,
          name: "list_buffers",
          input: {},
        },
        { nvim },
      );

      const app = createApp({
        nvim,
        initialModel: model,
        update: ListBuffers.update,
        View: ListBuffers.view,
      });

      const mountedApp = await app.mount({
        nvim,
        buffer,
        startPos: pos(0, 0),
        endPos: pos(-1, -1),
      });

      await mountedApp.waitForRender();

      const content = (await buffer.getLines({ start: 0, end: -1 })).join("\n");

      expect(content).toBe(`⚙️ Grabbing buffers...`);

      app.dispatch({
        type: "finish",
        result: {
          type: "tool_result",
          tool_use_id: "request_id" as ToolRequestId,
          content: "buffer list",
        },
      });

      await mountedApp.waitForRender();
      expect((await buffer.getLines({ start: 0, end: -1 })).join("\n")).toBe(
        `✅ Finished getting buffers.`,
      );
    });
  });
});
