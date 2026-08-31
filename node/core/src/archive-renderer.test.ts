import { describe, expect, it } from "vitest";
import { renderThreadLogToMarkdown } from "./archive-renderer.ts";
import {
  type NativeMessageIdx,
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
} from "./providers/provider-types.ts";
import type { ThreadLogEntry } from "./thread-logger.ts";
import type { ToolName, ToolRequestId } from "./tool-types.ts";

const idx: NativeMessageIdx = PLACEHOLDER_NATIVE_MESSAGE_IDX;
const reqId = "req-1" as ToolRequestId;

describe("renderThreadLogToMarkdown", () => {
  it("renders liberally and interleaves non-message markers inline", () => {
    const entries: ThreadLogEntry[] = [
      {
        type: "message",
        timestamp: "t0",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "secret reasoning",
              nativeMessageIdx: idx,
            },
            {
              type: "tool_use",
              id: reqId,
              name: "get_file" as ToolName,
              request: {
                status: "ok",
                value: {
                  id: reqId,
                  toolName: "get_file" as ToolName,
                  input: { filePath: "foo.ts" },
                },
              } as never,
              nativeMessageIdx: idx,
            },
          ],
        },
      },
      {
        type: "message",
        timestamp: "t1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              id: reqId,
              result: {
                status: "ok",
                value: [
                  {
                    type: "text",
                    text: "FULL FILE CONTENTS",
                    nativeMessageIdx: idx,
                  },
                ],
                structuredResult: { status: "ok", value: "" } as never,
              },
              nativeMessageIdx: idx,
            },
          ],
        },
      },
      { type: "title", timestamp: "t2", title: "My Thread" },
      {
        type: "compaction",
        timestamp: "t3",
        summary: "did stuff",
        chunkCount: 2,
      },
      {
        type: "message",
        timestamp: "t4",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "final answer", nativeMessageIdx: idx },
          ],
        },
      },
    ];

    const md = renderThreadLogToMarkdown(entries);

    // thinking is kept (unlike compaction)
    expect(md).toContain("secret reasoning");
    // full get_file contents are kept (unlike compaction)
    expect(md).toContain("FULL FILE CONTENTS");
    // inline markers appear
    expect(md).toContain('# title: "My Thread"');
    expect(md).toContain("--- compaction (2 chunks) ---");
    expect(md).toContain("did stuff");
    expect(md).toContain("final answer");

    // ordering: title marker comes before compaction marker before final answer
    expect(md.indexOf('# title: "My Thread"')).toBeLessThan(
      md.indexOf("--- compaction"),
    );
    expect(md.indexOf("--- compaction")).toBeLessThan(
      md.indexOf("final answer"),
    );
  });

  it("renders a compaction without a summary as just the header", () => {
    const entries: ThreadLogEntry[] = [
      { type: "compaction", timestamp: "t0", chunkCount: 3 },
    ];

    const md = renderThreadLogToMarkdown(entries);

    expect(md).toContain("--- compaction (3 chunks) ---");
    expect(md.trim()).toBe("--- compaction (3 chunks) ---");
  });

  it("renders tool_use parse errors and error tool_results", () => {
    const entries: ThreadLogEntry[] = [
      {
        type: "message",
        timestamp: "t0",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: reqId,
              name: "get_file" as ToolName,
              request: {
                status: "error",
                error: "bad input",
              } as never,
              nativeMessageIdx: idx,
            },
          ],
        },
      },
      {
        type: "message",
        timestamp: "t1",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              id: reqId,
              result: {
                status: "error",
                error: "tool blew up",
              },
              nativeMessageIdx: idx,
            } as never,
          ],
        },
      },
    ];

    const md = renderThreadLogToMarkdown(entries);

    expect(md).toContain("## tool_use: (parse error)");
    expect(md).toContain("tool blew up");
  });
});
