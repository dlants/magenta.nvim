import { assertUnreachable } from "../utils/assertUnreachable.ts";
import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { StaticToolRequest } from "./toolManager.ts";
import type {
  ProviderToolResult,
  ProviderToolResultContent,
  ProviderToolSpec,
} from "../providers/provider.ts";
import { applyEdit } from "./applyEdit.ts";
import type { Nvim } from "../nvim/nvim-node";
import type { RootMsg } from "../root-msg.ts";
import type { MessageId } from "../chat/message.ts";
import type { StaticTool, ToolName } from "./types.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import type { ThreadId } from "../chat/types.ts";

export type State =
  | {
      state: "processing";
    }
  | {
      state: "done";
      result: ProviderToolResult;
    };

export type Msg = {
  type: "finish";
  result: Result<ProviderToolResultContent[]>;
};

export class InsertTool implements StaticTool {
  state: State;
  toolName = "insert" as const;

  constructor(
    public request: Extract<StaticToolRequest, { toolName: "insert" }>,
    public threadId: ThreadId,
    public messageId: MessageId,
    private context: {
      myDispatch: Dispatch<Msg>;
      bufferTracker: BufferTracker;
      nvim: Nvim;
      dispatch: Dispatch<RootMsg>;
    },
  ) {
    this.state = { state: "processing" };

    // wrap in setTimeout to force a new eventloop frame, so we don't dispatch-in-dispatch
    setTimeout(() => {
      applyEdit(
        this.request,
        this.threadId,
        this.messageId,
        this.context,
      ).catch((err: Error) =>
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: err.message,
          },
        }),
      );
    });
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  abort() {
    this.state = {
      state: "done",
      result: {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "error",
          error: "The user aborted this tool request.",
        },
      },
    };
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "finish":
        if (this.state.state == "processing") {
          this.state = {
            state: "done",
            result: {
              type: "tool_result",
              id: this.request.id,
              result: msg.result,
            },
          };
        }
        return;
      default:
        assertUnreachable(msg.type);
    }
  }

  renderSummary(): VDOMNode {
    const lineCount =
      (this.request.input.content.match(/\n/g) || []).length + 1;

    switch (this.state.state) {
      case "processing":
        return d`✏️⚙️ Insert [[ +${lineCount.toString()} ]] in \`${this.request.input.filePath}\``;
      case "done":
        return d`✏️ Insert [[ +${lineCount.toString()} ]] in \`${this.request.input.filePath}\``;
      default:
        assertUnreachable(this.state);
    }
  }

  renderPreview(): VDOMNode {
    switch (this.state.state) {
      case "processing":
        return d``;
      case "done":
        if (this.state.result.result.status === "error") {
          return d`❌ ${this.state.result.result.error}`;
        } else {
          return d`✅ Insert applied
\`\`\`diff
${this.getInsertPreview()}
\`\`\``;
        }
      default:
        assertUnreachable(this.state);
    }
  }

  getInsertPreview(): string {
    const content = this.request.input.content;
    const lines = content.split("\n");
    const maxLines = 5;
    const maxLength = 80;

    let previewLines = lines.length > maxLines ? lines.slice(-maxLines) : lines;
    previewLines = previewLines.map((line) =>
      line.length > maxLength ? line.substring(0, maxLength) + "..." : line,
    );

    let result = previewLines.map((line) => "+ " + line).join("\n");
    if (lines.length > maxLines) {
      result = "...\n" + result;
    }

    return result;
  }
  getToolResult(): ProviderToolResult {
    switch (this.state.state) {
      case "done":
        return this.state.result;
      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              { type: "text", text: `This tool use is being processed.` },
            ],
          },
        };
      default:
        assertUnreachable(this.state);
    }
  }

  displayInput() {
    return `insert: {
    filePath: ${this.request.input.filePath}
    insertAfter: "${this.request.input.insertAfter}"
    content:
\`\`\`
${this.request.input.content}
\`\`\`
}`;
  }
}

export const spec: ProviderToolSpec = {
  name: "insert" as ToolName,
  description:
    "Insert content after the specified string in a file. You can also use this tool to create new files.",
  input_schema: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: `Path to the file to modify. The file will be created if it does not exist yet.`,
      },
      insertAfter: {
        type: "string",
        description: `String after which to insert the content.

The insertAfter string MUST uniquely identify a single location in the file. Provide at least 3 lines of context from the target file to ensure that the insert only matches ONE location.

If insertAfter only contains punctuation (new lines, braces), expand it to 5 or more lines until you get some identifiers.

Break up large inserts into smaller chunks (20-30 lines). This way, you are more likely to detect errors early and won't waste as much time generating an insert command that will fail.

This should exactly match the file content, including indentation. Regular expressions are not supported.

Content will be inserted on the same line, immediately after insertAfter. If you want to insert on a new line,
make sure to include the last newline character in insertAfter or start content with a new line.

Set insertAfter to the empty string to append to the end of the file.`,
      },
      content: {
        type: "string",
        description: `Content to insert immediately after the insertAfter text.
Make sure you match braces and indentation.
`,
      },
    },
    required: ["filePath", "insertAfter", "content"],
    additionalProperties: false,
  },
};

export type Input = {
  filePath: UnresolvedFilePath;
  insertAfter: string;
  content: string;
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.filePath != "string") {
    return {
      status: "error",
      error: "expected req.input.filePath to be a string",
    };
  }

  if (typeof input.insertAfter != "string") {
    return {
      status: "error",
      error: "expected req.input.insertAfter to be a string",
    };
  }

  if (typeof input.content != "string") {
    return {
      status: "error",
      error: "expected req.input.content to be a string",
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}

const CONTENT_START_STR = '"content":"';
export function renderStreamedBlock(streamed: string): VDOMNode {
  // Look for file path pattern
  const filePathMatch = streamed.match(/"filePath"\s*:\s*"([^"]+)"/);
  const filePath = filePathMatch ? filePathMatch[1] : null;

  // Check for content and count lines
  let lineCount = 1; // Start with 1 for the first line
  const contentKeyIndex = streamed.indexOf(CONTENT_START_STR);
  if (contentKeyIndex !== -1) {
    // Start after the opening quote
    for (
      let i = contentKeyIndex + CONTENT_START_STR.length;
      i < streamed.length;
      i++
    ) {
      const char = streamed[i];
      const prevChar = i > 0 ? streamed[i - 1] : "";

      if (char === '"' && prevChar !== "\\") {
        // Unescaped quote marks the end of content
        break;
      } else if (char === "n" && prevChar === "\\") {
        // Found a newline sequence
        lineCount++;
      }
    }
  }

  // Format the message in the same style as the view method
  if (filePath) {
    return d`⏳ Insert [[ +${lineCount.toString()} ]] in \`${filePath}\` streaming...`;
  } else {
    return d`⏳ Preparing insert operation...`;
  }
}
