import { assertUnreachable } from "../utils/assertUnreachable.ts";
import {
  d,
  type VDOMNode,
  withInlineCode,
  withCode,
  withExtmark,
  withBindings,
} from "../tea/view.ts";
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
import type { NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
import type { BufferTracker } from "../buffer-tracker.ts";
import { resolveFilePath } from "../utils/files.ts";
import type { MagentaOptions } from "../options.ts";
import { canWriteFile } from "./permissions.ts";
import type { ThreadId } from "../chat/types.ts";
import type { Gitignore } from "./util.ts";

export type State =
  | {
      state: "pending";
    }
  | {
      state: "processing";
      approved: boolean;
    }
  | {
      state: "pending-user-action";
    }
  | {
      state: "done";
      result: ProviderToolResult;
    };

export type Msg =
  | {
      type: "finish";
      result: Result<ProviderToolResultContent[]>;
    }
  | {
      type: "automatic-approval";
    }
  | {
      type: "request-user-approval";
    }
  | {
      type: "user-approval";
      approved: boolean;
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
      cwd: NvimCwd;
      dispatch: Dispatch<RootMsg>;
      options: MagentaOptions;
      getDisplayWidth: () => number;
      gitignore: Gitignore;
    },
  ) {
    this.state = { state: "pending" };

    // wrap in setTimeout to force a new eventloop frame, so we don't dispatch-in-dispatch
    setTimeout(() => {
      try {
        this.initInsert();
      } catch (error) {
        this.context.myDispatch({
          type: "finish",
          result: {
            status: "error",
            error: (error as Error).message + "\n" + (error as Error).stack,
          },
        });
      }
    });
  }

  private initInsert(): void {
    const filePath = this.request.input.filePath;
    const absFilePath = resolveFilePath(this.context.cwd, filePath);

    if (this.state.state === "pending") {
      const allowed = canWriteFile(absFilePath, this.context);

      if (allowed) {
        this.context.myDispatch({
          type: "automatic-approval",
        });
      } else {
        this.context.myDispatch({ type: "request-user-approval" });
      }
    }
  }

  private async doInsert(): Promise<void> {
    await applyEdit(this.request, this.threadId, this.messageId, this.context);
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  isPendingUserAction(): boolean {
    return this.state.state === "pending-user-action";
  }

  abort(): void {
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
        this.state = {
          state: "done",
          result: {
            type: "tool_result",
            id: this.request.id,
            result: msg.result,
          },
        };
        return;
      case "request-user-approval":
        if (this.state.state === "pending") {
          this.state = {
            state: "pending-user-action",
          };
        }
        return;
      case "user-approval": {
        if (this.state.state === "pending-user-action") {
          if (msg.approved) {
            this.state = {
              state: "processing",
              approved: true,
            };

            // wrap in setTimeout to force a new eventloop frame, to avoid dispatch-in-dispatch
            setTimeout(() => {
              this.doInsert().catch((error: Error) =>
                this.context.myDispatch({
                  type: "finish",
                  result: {
                    status: "error",
                    error: error.message + "\n" + error.stack,
                  },
                }),
              );
            });
            return;
          } else {
            this.state = {
              state: "done",
              result: {
                type: "tool_result",
                id: this.request.id,
                result: {
                  status: "error",
                  error: `The user did not allow this insertion.`,
                },
              },
            };
            return;
          }
        }
        return;
      }
      case "automatic-approval": {
        if (this.state.state === "pending") {
          this.state = {
            state: "processing",
            approved: true,
          };

          // wrap in setTimeout to force a new eventloop frame, to avoid dispatch-in-dispatch
          setTimeout(() => {
            this.doInsert().catch((error: Error) =>
              this.context.myDispatch({
                type: "finish",
                result: {
                  status: "error",
                  error: error.message + "\n" + error.stack,
                },
              }),
            );
          });
        }
        return;
      }
      default:
        assertUnreachable(msg);
    }
  }

  renderSummary(): VDOMNode {
    const lineCount =
      (this.request.input.content.match(/\n/g) || []).length + 1;

    switch (this.state.state) {
      case "pending":
      case "processing":
        return d`✏️⚙️ Insert [[ +${lineCount.toString()} ]] in ${withInlineCode(d`\`${this.request.input.filePath}\``)}`;
      case "pending-user-action":
        return d`✏️⏳ May I insert in file ${withInlineCode(d`\`${this.request.input.filePath}\``)}?

┌────────────────┐
│ ${withBindings(
          withExtmark(d`[ NO ]`, {
            hl_group: ["ErrorMsg", "@markup.strong.markdown"],
          }),
          {
            "<CR>": () =>
              this.context.myDispatch({
                type: "user-approval",
                approved: false,
              }),
          },
        )} ${withBindings(
          withExtmark(d`[ YES ]`, {
            hl_group: ["String", "@markup.strong.markdown"],
          }),
          {
            "<CR>": () =>
              this.context.myDispatch({
                type: "user-approval",
                approved: true,
              }),
          },
        )} │
└────────────────┘`;
      case "done":
        if (this.state.result.result.status === "error") {
          return d`✏️❌ Insert [[ +${lineCount.toString()} ]] in ${withInlineCode(d`\`${this.request.input.filePath}\``)} - ${this.state.result.result.error}`;
        } else {
          return d`✏️✅ Insert [[ +${lineCount.toString()} ]] in ${withInlineCode(d`\`${this.request.input.filePath}\``)}`;
        }
      default:
        assertUnreachable(this.state);
    }
  }

  renderPreview(): VDOMNode {
    switch (this.state.state) {
      case "pending":
      case "pending-user-action":
      case "processing":
        return d``;
      case "done":
        if (this.state.result.result.status === "error") {
          return d``;
        } else {
          const content = this.request.input.content;
          const lines = content.split("\n");
          const maxLines = 5;
          const maxLength = this.context.getDisplayWidth() - 5;

          let previewLines =
            lines.length > maxLines ? lines.slice(-maxLines) : lines;
          previewLines = previewLines.map((line) =>
            line.length > maxLength
              ? line.substring(0, maxLength) + "..."
              : line,
          );

          let result = previewLines.join("\n");
          if (lines.length > maxLines) {
            result = "...\n" + result;
          }

          return withCode(d`\`\`\`
${withExtmark(d`${result}`, { line_hl_group: "DiffAdd" })}
\`\`\``);
        }
      default:
        assertUnreachable(this.state);
    }
  }

  renderDetail(): VDOMNode {
    return d`\
filePath: ${withInlineCode(d`\`${this.request.input.filePath}\``)}
insertAfter: ${withInlineCode(d`\`${this.request.input.insertAfter}\``)}
content:
${withCode(d`\`\`\`
${withExtmark(d`${this.request.input.content}`, { line_hl_group: "DiffAdd" })}
\`\`\``)}`;
  }

  getToolResult(): ProviderToolResult {
    switch (this.state.state) {
      case "done":
        return this.state.result;
      case "pending":
      case "processing":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `This tool use is being processed. Please proceed with your answer or address other parts of the question.`,
              },
            ],
          },
        };
      case "pending-user-action":
        return {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "ok",
            value: [
              {
                type: "text",
                text: `Waiting for user approval to finish processing this tool use.`,
              },
            ],
          },
        };
      default:
        assertUnreachable(this.state);
    }
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
    return d`⏳ Insert [[ +${lineCount.toString()} ]] in ${withInlineCode(d`\`${filePath}\``)} streaming...`;
  } else {
    return d`⏳ Insert...`;
  }
}
