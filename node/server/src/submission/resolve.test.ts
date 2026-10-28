import { describe, expect, it, vi } from "vitest";
import { InMemoryFileIO } from "../edl/in-memory-file-io.ts";
import { noopLogger } from "../test-helpers.ts";
import type { ContextFileAccess } from "../thread.ts";
import type { HomeDir, ProjectDir } from "../utils/files.ts";
import { pendingMessage } from "./index.ts";
import { resolveSubmission } from "./resolve.ts";

function context(canCompact: boolean) {
  const addFileContext = vi.fn();
  return {
    addFileContext,
    ctx: {
      projectDir: "/proj" as ProjectDir,
      homeDir: "/home" as HomeDir,
      fileIO: new InMemoryFileIO({ "/proj/a.txt": "hello" }),
      logger: noopLogger,
      customCommands: [],
      getContextFiles: () =>
        ({ addFileContext }) as unknown as ContextFileAccess,
      canCompact,
      awaitClient: () => {
        throw new Error("no client commands expected");
      },
    },
  };
}

describe("resolveSubmission @compact", () => {
  it("compacts and still expands commands in the rest", async () => {
    const { ctx, addFileContext } = context(true);
    const result = await resolveSubmission(
      pendingMessage("@compact continue with @file:/proj/a.txt"),
      ctx,
      new Promise<never>(() => {}),
    );
    expect(result.type).toBe("compact");
    expect(result.prompt.content[0]).toEqual({
      type: "text",
      text: "continue with @file:/proj/a.txt",
    });
    expect(addFileContext).toHaveBeenCalled();
  });

  it("sends @compact as plain text when compaction is unavailable", async () => {
    const { ctx } = context(false);
    const result = await resolveSubmission(
      pendingMessage("@compact continue"),
      ctx,
      new Promise<never>(() => {}),
    );
    expect(result.type).toBe("send");
    expect(result.prompt.content[0]).toEqual({
      type: "text",
      text: "@compact continue",
    });
  });
});
