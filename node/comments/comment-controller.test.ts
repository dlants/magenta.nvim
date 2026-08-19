import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type CommentId,
  CommentStore,
  type HomeDir,
  type NvimCwd,
  type ToolName,
  type ToolRequestId,
} from "@magenta/core";
import { describe, expect, it, test } from "vitest";
import {
  type BufNr,
  type Line,
  MAGENTA_COMMENT_NAMESPACE,
  NvimBuffer,
} from "../nvim/buffer.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type { Row0Indexed } from "../nvim/window.ts";
import type { NvimDriver } from "../test/driver.ts";
import { withDriver, withNvimClient } from "../test/preamble.ts";
import { pollUntil } from "../utils/async.ts";
import type { AbsFilePath } from "../utils/files.ts";
import { CommentController } from "./comment-controller.ts";

function anchoredLocation(store: CommentStore, id: CommentId) {
  const location = store.comments[id].location;
  if (location.state !== "anchored") {
    throw new Error(`expected ${id} to be anchored, got ${location.state}`);
  }
  return location;
}

const rows = (start: number, end: number) => ({
  start: start as Row0Indexed,
  end: end as Row0Indexed,
});

async function setup(nvim: Nvim, lines: string[]) {
  const dir = await fs.mkdtemp("/tmp/magenta-comments-");
  const file = path.join(dir, "file.txt");
  await fs.writeFile(file, `${lines.join("\n")}\n`);
  const buffer = await NvimBuffer.bufadd(file as AbsFilePath, nvim);
  const store = new CommentStore();
  const controller = new CommentController(
    nvim,
    dir as NvimCwd,
    "/home/test" as HomeDir,
    store,
  );
  return { file, buffer, store, controller };
}

/** All render-namespace marks, sorted by row. */
async function renderMarks(buffer: NvimBuffer) {
  const marks = await buffer.getExtmarks(MAGENTA_COMMENT_NAMESPACE);
  return marks.sort((a, b) => a.startPos.row - b.startPos.row);
}

async function virtLines(buffer: NvimBuffer) {
  const marks = await renderMarks(buffer);
  const withVirt = marks.find((m) => m.options.virt_lines);
  return (withVirt?.options.virt_lines ?? []).map((chunks) =>
    chunks.map(([t]) => t).join(""),
  );
}

describe("CommentController", () => {
  it("stamps a sign, extent highlight and virtual lines", async () => {
    await withNvimClient(async (nvim) => {
      const { buffer, controller } = await setup(nvim, [
        "one",
        "two",
        "three",
        "four",
      ]);
      await controller.addComment({
        bufnr: buffer.id,
        rows: rows(1, 2),
        text: "why?",
      });

      const marks = await renderMarks(buffer);
      const lineMarks = marks.filter((m) => m.options.line_hl_group);
      expect(lineMarks.map((m) => m.startPos.row)).toEqual([1, 2]);
      expect(lineMarks[0].options.sign_text).toContain("💬");
      expect(lineMarks[1].options.sign_text).toBeUndefined();
      expect(await virtLines(buffer)).toEqual(["  you: why?", "  (pending)"]);
    });
  });

  it("keeps every message visible, in order", async () => {
    await withNvimClient(async (nvim) => {
      const { buffer, controller, store } = await setup(nvim, ["one", "two"]);
      const id = await controller.addComment({
        bufnr: buffer.id,
        rows: rows(0, 0),
        text: "first",
      });
      store.commitPending();
      store.addAgentMessage(id, "because");
      store.addUserMessage(id, "ok but why");
      await controller.refreshBuffer(buffer.id);

      expect(await virtLines(buffer)).toEqual([
        "  you: first",
        "  agent: because",
        "  you: ok but why",
        "  (pending)",
      ]);
    });
  });

  it("follows a user insert above the range", async () => {
    await withNvimClient(async (nvim) => {
      const { buffer, controller, store } = await setup(nvim, [
        "one",
        "two",
        "three",
      ]);
      const id = await controller.addComment({
        bufnr: buffer.id,
        rows: rows(1, 1),
        text: "why?",
      });

      await buffer.setLines({
        start: 0 as Row0Indexed,
        end: 0 as Row0Indexed,
        lines: ["zero"] as Line[],
      });
      await controller.refreshBuffer(buffer.id);

      const lineMarks = (await renderMarks(buffer)).filter(
        (m) => m.options.line_hl_group,
      );
      expect(lineMarks.map((m) => m.startPos.row)).toEqual([2]);
      expect(anchoredLocation(store, id).lines).toEqual({ start: 3, end: 3 });
      expect(anchoredLocation(store, id).selection).toEqual("two");
    });
  });

  it("goes stale when the commented lines are deleted", async () => {
    await withNvimClient(async (nvim) => {
      const { buffer, controller, store } = await setup(nvim, [
        "one",
        "two",
        "three",
      ]);
      const id = await controller.addComment({
        bufnr: buffer.id,
        rows: rows(1, 1),
        text: "why?",
      });

      await buffer.setLines({
        start: 1 as Row0Indexed,
        end: 2 as Row0Indexed,
        lines: [] as Line[],
      });
      await controller.refreshBuffer(buffer.id);

      expect(store.comments[id].location.state).toEqual("stale");
      const parts = store.getPendingUpdate();
      expect(parts[0].type === "text" && parts[0].text).toContain(
        "the commented range was deleted",
      );
      expect(await virtLines(buffer)).toContain(
        "  (stale: the commented range was deleted)",
      );
    });
  });

  it("creates a new comment on rows a stale comment used to occupy", async () => {
    await withNvimClient(async (nvim) => {
      const { buffer, controller, store } = await setup(nvim, [
        "one",
        "two",
        "three",
      ]);
      const stale = await controller.addComment({
        bufnr: buffer.id,
        rows: rows(1, 1),
        text: "why?",
      });
      await buffer.setLines({
        start: 1 as Row0Indexed,
        end: 2 as Row0Indexed,
        lines: [] as Line[],
      });
      await controller.refreshBuffer(buffer.id);
      expect(store.comments[stale].location.state).toEqual("stale");

      const fresh = await controller.addComment({
        bufnr: buffer.id,
        rows: rows(1, 1),
        text: "and this?",
      });
      expect(fresh).not.toEqual(stale);
      expect(store.comments[fresh].messages).toHaveLength(1);
      expect(store.comments[stale].messages).toHaveLength(1);
    });
  });

  it("appends a follow-up instead of creating an overlapping comment", async () => {
    await withNvimClient(async (nvim) => {
      const { buffer, controller, store } = await setup(nvim, [
        "one",
        "two",
        "three",
      ]);
      const first = await controller.addComment({
        bufnr: buffer.id,
        rows: rows(0, 1),
        text: "why?",
      });
      const second = await controller.addComment({
        bufnr: buffer.id,
        rows: rows(1, 2),
        text: "also this",
      });

      expect(second).toEqual(first);
      expect(store.listOpenCommentIds()).toEqual([first]);
      expect(await virtLines(buffer)).toEqual([
        "  you: why?",
        "  you: also this",
        "  (pending)",
      ]);
    });
  });

  it("hides and restores decorations without touching the highlight namespace", async () => {
    await withNvimClient(async (nvim) => {
      const { buffer, controller } = await setup(nvim, ["one", "two"]);
      await buffer.setExtmark({
        startPos: { row: 0, col: 0 } as never,
        endPos: { row: 0, col: 1 } as never,
        options: { hl_group: "ErrorMsg" },
      });
      await controller.addComment({
        bufnr: buffer.id,
        rows: rows(0, 0),
        text: "why?",
      });

      await controller.hide();
      expect(await renderMarks(buffer)).toEqual([]);
      expect(await buffer.getExtmarks()).toHaveLength(1);

      await controller.show();
      expect((await renderMarks(buffer)).length).toBeGreaterThan(0);
      expect(await buffer.getExtmarks()).toHaveLength(1);
    });
  });

  it("deletes a comment and its rendering", async () => {
    await withNvimClient(async (nvim) => {
      const { buffer, controller, store } = await setup(nvim, ["one", "two"]);
      const id = await controller.addComment({
        bufnr: buffer.id,
        rows: rows(0, 0),
        text: "why?",
      });
      await controller.deleteComment(id);

      expect(store.listOpenCommentIds()).toEqual([]);
      expect(await renderMarks(buffer)).toEqual([]);
    });
  });

  it("renders a comment on a non-file scratch buffer", async () => {
    await withNvimClient(async (nvim) => {
      const dir = await fs.mkdtemp("/tmp/magenta-comments-");
      const buffer = await NvimBuffer.create(false, true, nvim);
      await buffer.setOption("buftype", "nofile");
      await buffer.setName("magenta-scratch");
      await buffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["scratch line"] as Line[],
      });
      const store = new CommentStore();
      const controller = new CommentController(
        nvim,
        dir as NvimCwd,
        "/home/test" as HomeDir,
        store,
      );

      const id = await controller.addComment({
        bufnr: buffer.id,
        rows: rows(0, 0),
        text: "what is this?",
      });

      expect(await virtLines(buffer)).toContain("  you: what is this?");
      expect(store.comments[id].location.bufnr).toEqual(buffer.id);
      expect(store.comments[id].location.bufferLabel).toContain(
        "magenta-scratch",
      );
    });
  });

  it("closes comments when their buffer is wiped", async () => {
    await withNvimClient(async (nvim) => {
      const { file, buffer, controller, store } = await setup(nvim, [
        "one",
        "two",
      ]);
      const id = await controller.addComment({
        bufnr: buffer.id,
        rows: rows(0, 0),
        text: "why?",
      });
      store.commitPending();

      const bufnr = buffer.id;
      await controller.closeBuffer(bufnr);
      await buffer.delete({ force: true });

      expect(store.listOpenCommentIds()).toEqual([]);
      const parts = store.getPendingUpdate();
      expect(parts[0].type === "text" && parts[0].text).toContain(`${id} `);
      expect(parts[0].type === "text" && parts[0].text).toContain(
        "closed: buffer unloaded",
      );

      // reopening the same path does not restore the comment
      const reopened = await NvimBuffer.bufadd(file as AbsFilePath, nvim);
      await controller.refreshBuffer(reopened.id);
      expect(await renderMarks(reopened)).toEqual([]);
    });
  });
});

describe("comments and agent edits", () => {
  async function runEdlScript(driver: NvimDriver, script: string) {
    await driver.showSidebar();
    await driver.inputMagentaText("edit the file");
    await driver.send();
    const stream = await driver.mockAnthropic.awaitPendingStream();
    stream.respond({
      stopReason: "tool_use",
      text: "editing",
      toolRequests: [
        {
          status: "ok",
          value: {
            id: "tool_1" as ToolRequestId,
            toolName: "edl" as ToolName,
            input: { script },
          },
        },
      ],
    });
  }

  test("the anchor moves when the agent inserts a line above", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(
            path.join(tmpDir, "test.txt"),
            "one\ntwo\nthree\n",
          );
        },
      },
      async (driver, dirs) => {
        const filePath = path.join(dirs.tmpDir, "test.txt");
        await driver.editFile(filePath);
        const bufnr = (await driver.nvim.call(
          "nvim_get_current_buf",
          [],
        )) as BufNr;
        const buffer = new NvimBuffer(bufnr, driver.nvim);
        const store = new CommentStore();
        const controller = new CommentController(
          driver.nvim,
          dirs.tmpDir as NvimCwd,
          "/home/test" as HomeDir,
          store,
        );
        const id = await controller.addComment({
          bufnr,
          rows: rows(1, 1),
          text: "why?",
        });

        await runEdlScript(
          driver,
          `file \`${filePath}\`
select /one/
insert_before <<INS
zero
INS`,
        );

        await pollUntil(async () => {
          const lines = await buffer.getLines({
            start: 0 as Row0Indexed,
            end: -1 as Row0Indexed,
          });
          if (lines[0] !== "zero") {
            throw new Error("buffer not reloaded yet");
          }
        });

        await controller.refreshBuffer(bufnr);
        expect(anchoredLocation(store, id).selection).toEqual("two");
      },
    );
  });

  test("the comment goes stale when the agent deletes the range", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fs.writeFile(
            path.join(tmpDir, "test.txt"),
            "one\ntwo\nthree\n",
          );
        },
      },
      async (driver, dirs) => {
        const filePath = path.join(dirs.tmpDir, "test.txt");
        await driver.editFile(filePath);
        const bufnr = (await driver.nvim.call(
          "nvim_get_current_buf",
          [],
        )) as BufNr;
        const buffer = new NvimBuffer(bufnr, driver.nvim);
        const store = new CommentStore();
        const controller = new CommentController(
          driver.nvim,
          dirs.tmpDir as NvimCwd,
          "/home/test" as HomeDir,
          store,
        );
        const id = await controller.addComment({
          bufnr,
          rows: rows(1, 1),
          text: "why?",
        });

        await runEdlScript(
          driver,
          `file \`${filePath}\`
select <<SEL
two
SEL
delete`,
        );

        await pollUntil(async () => {
          const lines = await buffer.getLines({
            start: 0 as Row0Indexed,
            end: -1 as Row0Indexed,
          });
          if (lines.includes("two" as Line)) {
            throw new Error("buffer not reloaded yet");
          }
        });

        await controller.refreshBuffer(bufnr);
        expect(store.comments[id].location.state).toEqual("stale");
      },
    );
  });
});
