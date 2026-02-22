import { describe, it, expect } from "vitest";
import { renderThreadToMarkdown, chunkMessages } from "./compact-renderer.ts";
import type { ProviderMessage } from "../providers/provider-types.ts";
import type { ToolRequestId } from "../tools/toolManager.ts";
import type { ToolName } from "../tools/types.ts";

describe("renderThreadToMarkdown", () => {
  it("renders a simple text conversation", () => {
    const messages: ProviderMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
      },
    ];

    const { markdown: result } = renderThreadToMarkdown(messages);
    expect(result).toContain("# user:");
    expect(result).toContain("Hello");
    expect(result).toContain("# assistant:");
    expect(result).toContain("Hi there!");
  });

  it("skips thinking blocks", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me think...", signature: "sig" },
          { type: "text", text: "Here is my answer" },
        ],
      },
    ];

    const { markdown: result } = renderThreadToMarkdown(messages);
    expect(result).not.toContain("Let me think");
    expect(result).toContain("Here is my answer");
  });

  it("skips redacted thinking blocks", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "secret" },
          { type: "text", text: "visible text" },
        ],
      },
    ];

    const { markdown: result } = renderThreadToMarkdown(messages);
    expect(result).not.toContain("secret");
    expect(result).toContain("visible text");
  });

  it("skips system reminders", () => {
    const messages: ProviderMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "My question" },
          { type: "system_reminder", text: "Remember to be helpful" },
        ],
      },
    ];

    const { markdown: result } = renderThreadToMarkdown(messages);
    expect(result).not.toContain("Remember to be helpful");
    expect(result).toContain("My question");
  });

  it("summarizes context updates with file paths", () => {
    const messages: ProviderMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "context_update",
            text: `<context_update>
<file_paths>
src/index.ts (2 lines)
src/utils.ts (+1/-0)
</file_paths>
These files are part of your context.
File \`src/index.ts\`
const x = 1;
- \`/Users/me/project/src/utils.ts\`
\`\`\`diff
+new line
\`\`\`
</context_update>`,
          },
        ],
      },
    ];

    const { markdown: result } = renderThreadToMarkdown(messages);
    expect(result).toContain(
      "[context update: `src/index.ts`, `src/utils.ts`]",
    );
    expect(result).not.toContain("const x = 1");
    expect(result).not.toContain("new line");
  });
  it("does not extract file paths from markdown list items in file contents", () => {
    const messages: ProviderMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "context_update",
            text: `<context_update>
<file_paths>
context.md (8 lines)
</file_paths>
These files are part of your context.
File \`context.md\`
# Architecture

- \`Controllers\` - Classes that manage specific parts of the application.
- \`Msg/RootMsg\` - Messages that trigger state changes.
- \`dispatch/myDispatch\` - Functions passed to controllers.
- \`view\` - A function that renders the current controller state in TUI.
</context_update>`,
          },
        ],
      },
    ];

    const { markdown: result } = renderThreadToMarkdown(messages);
    expect(result).toContain("[context update: `context.md`]");
    expect(result).not.toContain("Controllers");
    expect(result).not.toContain("Msg/RootMsg");
    expect(result).not.toContain("dispatch/myDispatch");
    expect(result).not.toContain("view");
  });

  it("falls back to generic context update when no files found", () => {
    const messages: ProviderMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "context_update",
            text: "some context update without file patterns",
          },
        ],
      },
    ];

    const { markdown: result } = renderThreadToMarkdown(messages);
    expect(result).toContain("[context update]");
  });

  it("renders tool_use with parsed input", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_1" as ToolRequestId,
            name: "get_file" as ToolName,
            request: {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "get_file" as ToolName,
                input: { filePath: "src/index.ts" },
              },
            },
          },
        ],
      },
    ];

    const { markdown: result } = renderThreadToMarkdown(messages);
    expect(result).toContain("## tool_use: get_file");
    expect(result).toContain('"filePath": "src/index.ts"');
  });

  it("renders tool_use parse error", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_1" as ToolRequestId,
            name: "get_file" as ToolName,
            request: {
              status: "error",
              error: "parse error",
              rawRequest: {},
            },
          },
        ],
      },
    ];

    const { markdown: result } = renderThreadToMarkdown(messages);
    expect(result).toContain("(parse error)");
  });

  it("renders tool_result with text content", () => {
    const messages: ProviderMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            id: "tool_1" as ToolRequestId,
            result: {
              status: "ok",
              value: [{ type: "text", text: "File contents here" }],
            },
          },
        ],
      },
    ];

    const { markdown: result } = renderThreadToMarkdown(messages);
    expect(result).toContain("## tool_result");
    expect(result).toContain("File contents here");
  });

  it("renders tool_result error", () => {
    const messages: ProviderMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            id: "tool_1" as ToolRequestId,
            result: {
              status: "error",
              error: "File not found",
            },
          },
        ],
      },
    ];

    const { markdown: result } = renderThreadToMarkdown(messages);
    expect(result).toContain("tool_result (error)");
    expect(result).toContain("File not found");
  });

  it("renders image and document placeholders", () => {
    const messages: ProviderMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "abc123",
            },
          },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: "abc123",
            },
            title: "report.pdf",
          },
        ],
      },
    ];

    const { markdown: result } = renderThreadToMarkdown(messages);
    expect(result).toContain("[Image]");
    expect(result).toContain("[Document: report.pdf]");
    expect(result).not.toContain("abc123");
  });

  it("renders web search tool use and results with titles and urls", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "search_1",
            name: "web_search" as const,
            input: { query: "vitest documentation" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "search_1",
            content: [
              {
                type: "web_search_result" as const,
                title: "Vitest | Next Generation Testing",
                url: "https://vitest.dev",
                encrypted_content: "encrypted_data_here",
                page_age: "2 days ago",
              },
              {
                type: "web_search_result" as const,
                title: "Getting Started | Vitest",
                url: "https://vitest.dev/guide",
                encrypted_content: "more_encrypted_data",
                page_age: null,
              },
            ],
          },
        ],
      },
    ];

    const { markdown: result } = renderThreadToMarkdown(messages);
    expect(result).toContain("[web search: vitest documentation]");
    expect(result).toContain("[search results]");
    expect(result).toContain(
      "[Vitest | Next Generation Testing](https://vitest.dev) (2 days ago)",
    );
    expect(result).toContain(
      "[Getting Started | Vitest](https://vitest.dev/guide)",
    );
    // Should NOT include encrypted content
    expect(result).not.toContain("encrypted_data_here");
    expect(result).not.toContain("more_encrypted_data");
  });

  it("truncates get_file tool results", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_1" as ToolRequestId,
            name: "get_file" as ToolName,
            request: {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "get_file" as ToolName,
                input: { filePath: "src/index.ts" },
              },
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            id: "tool_1" as ToolRequestId,
            result: {
              status: "ok",
              value: [
                {
                  type: "text",
                  text: "const x = 1;\nconst y = 2;\n// lots of file content here...",
                },
              ],
            },
          },
        ],
      },
    ];

    const { markdown: result } = renderThreadToMarkdown(messages);
    expect(result).toContain("## tool_use: get_file");
    expect(result).toContain("[file contents omitted]");
    // Should NOT include the actual file contents
    expect(result).not.toContain("const x = 1");
    expect(result).not.toContain("lots of file content");
  });

  it("truncates get_file error results", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_1" as ToolRequestId,
            name: "get_file" as ToolName,
            request: {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "get_file" as ToolName,
                input: { filePath: "nonexistent.ts" },
              },
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            id: "tool_1" as ToolRequestId,
            result: {
              status: "error",
              error: "File not found: nonexistent.ts",
            },
          },
        ],
      },
    ];

    const { markdown: result } = renderThreadToMarkdown(messages);
    expect(result).toContain("tool_result (error)");
    expect(result).toContain("File not found: nonexistent.ts");
  });

  it("does not truncate non-get_file tool results", () => {
    const messages: ProviderMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_1" as ToolRequestId,
            name: "bash_command" as ToolName,
            request: {
              status: "ok",
              value: {
                id: "tool_1" as ToolRequestId,
                toolName: "bash_command" as ToolName,
                input: { command: "echo hello" },
              },
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            id: "tool_1" as ToolRequestId,
            result: {
              status: "ok",
              value: [{ type: "text", text: "hello" }],
            },
          },
        ],
      },
    ];

    const { markdown: result } = renderThreadToMarkdown(messages);
    expect(result).toContain("hello");
    expect(result).not.toContain("[file contents omitted]");
  });

  it("returns correct message boundaries", () => {
    const messages: ProviderMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Goodbye" }],
      },
    ];

    const { markdown, messageBoundaries } = renderThreadToMarkdown(messages);
    expect(messageBoundaries).toHaveLength(3);
    expect(messageBoundaries[0]).toBe(0);

    // Each boundary should point to the start of "# role:"
    for (const boundary of messageBoundaries) {
      expect(markdown.substring(boundary, boundary + 2)).toBe("# ");
    }
  });

  it("returns empty boundaries for empty messages", () => {
    const { markdown, messageBoundaries } = renderThreadToMarkdown([]);
    expect(markdown).toBe("");
    expect(messageBoundaries).toEqual([]);
  });
});

describe("chunkMessages", () => {
  it("returns empty array for empty markdown + no boundaries", () => {
    expect(chunkMessages("", [], 20, 5)).toEqual([]);
  });

  it("returns one chunk for a single small message", () => {
    const md = "# user:\nHello\n";
    const chunks = chunkMessages(md, [0], 100, 20);
    expect(chunks).toEqual([md]);
  });

  it("returns one chunk when multiple small messages fit", () => {
    const msg1 = "# user:\nHello\n";
    const msg2 = "# assistant:\nHi\n";
    const md = msg1 + msg2;
    const chunks = chunkMessages(md, [0, msg1.length], 200, 50);
    expect(chunks).toEqual([md]);
  });

  it("splits at message boundaries when messages exceed budget", () => {
    const msg1 = "A".repeat(15);
    const msg2 = "B".repeat(15);
    const msg3 = "C".repeat(15);
    const md = msg1 + msg2 + msg3;
    // target=20, tolerance=5, so max=25
    // msg1 (15) fits in chunk 1
    // msg1+msg2 (30) > max(25), so msg1 is flushed? No, msg1 < target(20), so combined(30) > max(25), split
    const chunks = chunkMessages(md, [0, 15, 30], 20, 5);
    // All chunks concatenated should equal the original
    expect(chunks.join("")).toBe(md);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("keeps a single message within tolerance in one chunk", () => {
    // target=20, tolerance=5, message=23 chars → within max(25), no split
    const md = "X".repeat(23);
    const chunks = chunkMessages(md, [0], 20, 5);
    expect(chunks).toEqual([md]);
  });

  it("splits a single message that exceeds tolerance", () => {
    // target=20, tolerance=5, message=26 chars → exceeds max(25)
    const md = "X".repeat(26);
    const chunks = chunkMessages(md, [0], 20, 5);
    expect(chunks.length).toBe(2);
    expect(chunks.join("")).toBe(md);
  });

  it("splits a very large single message into multiple chunks", () => {
    // target=20, tolerance=5, message=55 chars
    const md = "X".repeat(55);
    const chunks = chunkMessages(md, [0], 20, 5);
    // 55 / 20 = 2.75, so 3 chunks
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe(md);
  });

  it("handles mix of small messages then a giant message", () => {
    const small1 = "A".repeat(8);
    const small2 = "B".repeat(8);
    const giant = "C".repeat(55);
    const md = small1 + small2 + giant;
    const chunks = chunkMessages(md, [0, 8, 16], 20, 5);
    expect(chunks.join("")).toBe(md);
    // small1+small2 = 16, fits in one chunk
    // giant = 55, needs splitting
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("preserves all content: concatenated chunks equal original", () => {
    const msgs = Array.from(
      { length: 10 },
      (_, i) => `msg${i}:${"x".repeat(12)}\n`,
    );
    const md = msgs.join("");
    const boundaries = [];
    let offset = 0;
    for (const msg of msgs) {
      boundaries.push(offset);
      offset += msg.length;
    }
    const chunks = chunkMessages(md, boundaries, 40, 10);
    expect(chunks.join("")).toBe(md);
  });
});
