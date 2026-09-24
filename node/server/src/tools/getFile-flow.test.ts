import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { type Harness, withHarness } from "../test/harness.ts";
import type { Thread } from "../thread.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";

const fixture = (name: string) =>
  fs.readFileSync(path.join(import.meta.dirname, "../test/fixtures", name));

const POEM = "Moonlight whispers through the trees\n";

async function seed(h: Harness) {
  await h.fileIO.writeFile("/project/poem.txt", POEM);
  await h.fileIO.writeBinaryFile("/project/test.jpg", fixture("test.jpg"));
  await h.fileIO.writeBinaryFile(
    "/project/sample2.pdf",
    fixture("sample2.pdf"),
  );
}

/** Answer the pending turn with a get_files call for `filePath`, and wait for
 * the follow-up request that carries its result. */
async function getFile(h: Harness, filePath: string) {
  (await h.nextStream()).respond({
    stopReason: "tool_use",
    text: `reading ${filePath}`,
    toolRequests: [
      {
        status: "ok",
        value: {
          id: `get-${filePath}` as ToolRequestId,
          toolName: "get_files" as ToolName,
          input: { files: [{ filePath }] },
        },
      },
    ],
  });
}

const categories = (thread: Thread) =>
  Object.fromEntries(
    Object.values(thread.contextFiles.files).map((f) => [
      f.relFilePath,
      f.fileTypeInfo.category,
    ]),
  );

async function readOne(filePath: string) {
  return withHarness({}, async (h) => {
    await seed(h);
    const { thread } = await h.createRoot();
    expect(thread.contextFiles.files).toEqual({});
    void h.send(thread, `read ${filePath}`);
    await getFile(h, filePath);
    await h.nextStream();
    return categories(thread);
  });
}

it("getFile adds file to context after reading", async () => {
  expect(await readOne("poem.txt")).toEqual({ "poem.txt": "text" });
});

it("should add images to context manager", async () => {
  expect(await readOne("test.jpg")).toEqual({ "test.jpg": "image" });
});

it("should add PDFs to context manager", async () => {
  expect(await readOne("sample2.pdf")).toEqual({ "sample2.pdf": "pdf" });
});

it("should handle mixed content types in a single conversation", () =>
  withHarness({}, async (h) => {
    await seed(h);
    const { thread } = await h.createRoot();
    void h.send(thread, "read everything");
    for (const file of ["poem.txt", "test.jpg", "sample2.pdf"]) {
      await getFile(h, file);
    }
    await h.nextStream();
    expect(categories(thread)).toEqual({
      "poem.txt": "text",
      "test.jpg": "image",
      "sample2.pdf": "pdf",
    });
  }));
