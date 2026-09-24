import { expect, it } from "vitest";
import type { Harness } from "./test/harness.ts";
import { withHarness } from "./test/harness.ts";
import type { Thread } from "./thread.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";

async function editTurn(h: Harness, thread: Thread, script: string) {
  const done = h.send(thread, "edit");
  (await h.nextStream()).respond({
    stopReason: "tool_use",
    text: "editing",
    toolRequests: [
      {
        status: "ok",
        value: {
          id: `t${Math.random()}` as ToolRequestId,
          toolName: "edl" as ToolName,
          input: { script },
        },
      },
    ],
  });
  (await h.nextStream()).respond({
    stopReason: "end_turn",
    text: "done",
    toolRequests: [],
  });
  await done;
}

it("records before/after snapshots per turn and keeps earlier groups", () =>
  withHarness(
    { files: { "/project/a.txt": "hello\n", "/project/b.txt": "world\n" } },
    async (h) => {
      const { thread } = await h.createRoot();
      expect(thread.editedFileGroups).toEqual([]);

      await editTurn(
        h,
        thread,
        'file `/project/a.txt`\nnarrow /hello/\nreplace "bye"',
      );
      expect(thread.editedFileGroups).toHaveLength(1);
      expect(thread.editedFileGroups[0]?.files).toEqual([
        { path: "/project/a.txt", snapshot: "hello\n", content: "bye\n" },
      ]);
      expect(thread.editedFileGroups[0]?.endNativeMessageIdx).toBeDefined();

      await editTurn(
        h,
        thread,
        'file `/project/b.txt`\nnarrow /world/\nreplace "earth"',
      );
      const groups = thread.editedFileGroups;
      expect(groups.map((g) => g.files.map((f) => f.path))).toEqual([
        ["/project/a.txt"],
        ["/project/b.txt"],
      ]);
      expect(groups[1]?.files[0]).toMatchObject({
        snapshot: "world\n",
        content: "earth\n",
      });
    },
  ));

it("records a created file with an empty snapshot", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    await editTurn(
      h,
      thread,
      "newfile `/project/new.txt`\ninsert_after <<E\nfresh\nE",
    );
    expect(thread.editedFileGroups[0]?.files).toEqual([
      { path: "/project/new.txt", snapshot: "", content: "fresh\n" },
    ]);
  }));
