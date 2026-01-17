import { d, type VDOMNode } from "../tea/view.ts";
import { type Result } from "../utils/result.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type {
  GenericToolRequest,
  StaticTool,
  ToolName,
  CompletedToolInfo,
} from "./types.ts";
import type { UnresolvedFilePath } from "../utils/files.ts";
import type { Dispatch } from "../tea/tea.ts";
import type { RootMsg } from "../root-msg.ts";
import type { ThreadId } from "../chat/types.ts";
import type { Chat } from "../chat/chat.ts";

export type Msg = {
  type: "finish";
};

export type State =
  | {
      state: "pending";
    }
  | {
      state: "done";
      result: ProviderToolResult;
    };

export class ForkThreadTool implements StaticTool {
  toolName = "fork_thread" as const;
  public state: State;
  public aborted: boolean = false;

  constructor(
    public request: ToolRequest,
    public context: {
      nvim: Nvim;
      chat: Chat;
      threadId: ThreadId;
      dispatch: Dispatch<RootMsg>;
      myDispatch: Dispatch<Msg>;
    },
  ) {
    this.state = { state: "pending" };

    try {
      this.doFork();
    } catch (error) {
      this.state = {
        state: "done",
        result: {
          type: "tool_result",
          id: this.request.id,
          result: {
            status: "error",
            error:
              error instanceof Error ? error.message : "Fork operation failed",
          },
        },
      };
    }
  }

  doFork() {
    const threadWrapper =
      this.context.chat.threadWrappers[this.context.threadId];
    if (threadWrapper.state != "initialized") {
      throw new Error(
        `Cannot fork thread ${this.context.threadId}. Thread not initialized.`,
      );
    }

    const thread = threadWrapper.thread;
    const pendingPrompt = thread.forkNextPrompt;
    if (!pendingPrompt) {
      throw new Error(
        `No pending prompt found for thread ${this.context.threadId}`,
      );
    }

    this.context.dispatch({
      type: "chat-msg",
      msg: {
        type: "fork-thread",
        threadId: this.context.threadId,
        toolRequestId: this.request.id,
        contextFilePaths: this.request.input.contextFiles,
        inputMessages: [
          {
            type: "system",
            text: `# Previous thread summary:
${this.request.input.summary}
# The user would like you to address this prompt next:
`,
          },
          { type: "user", text: pendingPrompt },
        ],
      },
    });
  }

  isDone(): boolean {
    return this.state.state === "done";
  }

  isPendingUserAction(): boolean {
    return false;
  }

  abort(): ProviderToolResult {
    if (this.state.state === "done") {
      return this.getToolResult();
    }

    this.aborted = true;

    const result: ProviderToolResult = {
      type: "tool_result",
      id: this.request.id,
      result: {
        status: "error",
        error: "Request was aborted by the user.",
      },
    };

    this.state = {
      state: "done",
      result,
    };

    return result;
  }

  update(msg: Msg): void {
    switch (msg.type) {
      case "finish":
        this.state = {
          state: "done",
          result: {
            type: "tool_result",
            id: this.request.id,
            result: this.aborted
              ? {
                  status: "error",
                  error: "Fork operation was aborted.",
                }
              : {
                  status: "ok",
                  value: [{ type: "text", text: "Fork completed." }],
                },
          },
        };
        return;
    }
  }

  getToolResult(): ProviderToolResult {
    if (this.state.state == "pending") {
      return {
        type: "tool_result",
        id: this.request.id,
        result: {
          status: "ok",
          value: [{ type: "text", text: "Fork request is pending." }],
        },
      };
    }

    return this.state.result;
  }

  renderSummary() {
    switch (this.state.state) {
      case "pending":
        return d`Forking thread...`;

      case "done":
        return renderCompletedSummary({
          request: this.request as CompletedToolInfo["request"],
          result: this.state.result,
        });
    }
  }
}

function isError(result: ProviderToolResult): boolean {
  return result.result.status === "error";
}

function getStatusEmoji(result: ProviderToolResult): string {
  return isError(result) ? "❌" : "✅";
}

export function renderCompletedSummary(info: CompletedToolInfo): VDOMNode {
  const status = getStatusEmoji(info.result);
  return d`🍴${status} fork_thread`;
}

export const spec: ProviderToolSpec = {
  name: "fork_thread" as ToolName,
  description: `Fork this thread. Use this ONLY when directly asked by the user to do so.`,
  input_schema: {
    type: "object",
    properties: {
      contextFiles: {
        type: "array",
        items: {
          type: "string",
        },
        description:
          "List of file names directly relevant to addressing the user's next prompt.",
      },
      summary: {
        type: "string",
        description: `A summary of the previous thread.`,
      },
    },
    required: ["contextFiles", "summary"],
  },
};

export type Input = {
  contextFiles: UnresolvedFilePath[];
  summary: string;
};

export type ToolRequest = GenericToolRequest<"fork_thread", Input>;

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (typeof input.summary != "string") {
    return {
      status: "error",
      error: `expected req.input.summary to be a string but it was ${JSON.stringify(input.summary)}`,
    };
  }

  if (!Array.isArray(input.contextFiles)) {
    return {
      status: "error",
      error: `expected req.input.contextFiles to be an array but it was ${JSON.stringify(input.contextFiles)}`,
    };
  }

  if (!input.contextFiles.every((item) => typeof item === "string")) {
    return {
      status: "error",
      error: `expected all items in req.input.contextFiles to be strings but they were ${JSON.stringify(input.contextFiles)}`,
    };
  }

  return {
    status: "ok",
    value: input as Input,
  };
}
