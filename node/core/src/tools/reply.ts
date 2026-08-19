import type { CommentId, CommentStore } from "../context/comment-store.ts";
import {
  PLACEHOLDER_NATIVE_MESSAGE_IDX,
  type ProviderToolResult,
  type ProviderToolSpec,
} from "../providers/provider-types.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolName,
} from "../tool-types.ts";
import type { Result } from "../utils/result.ts";

export type Reply = { commentId: CommentId; text: string };
export type Input = { replies: Reply[] };
export type ToolRequest = GenericToolRequest<"reply", Input>;
export type PerReplyResult = { commentId: CommentId } & (
  | { status: "ok" }
  | { status: "error"; error: string }
);
export type StructuredResult = {
  toolName: "reply";
  replies: PerReplyResult[];
};

/** Each reply is applied independently: an unknown id fails only its own
 * entry, so a batch never discards the replies that did land. */
export function execute(
  request: ToolRequest,
  context: { commentStore: CommentStore },
): ToolInvocation {
  const promise = (async (): Promise<ProviderToolResult> => {
    const replies: PerReplyResult[] = [];
    const lines: string[] = [];
    for (const reply of request.input.replies) {
      const result = context.commentStore.addAgentMessage(
        reply.commentId,
        reply.text,
      );
      if (result.status === "error") {
        replies.push({
          commentId: reply.commentId,
          status: "error",
          error: result.error,
        });
        lines.push(`${reply.commentId}: error - ${result.error}`);
      } else {
        replies.push({ commentId: reply.commentId, status: "ok" });
        lines.push(`${reply.commentId}: replied`);
      }
    }
    if (lines.length === 0) {
      lines.push("No replies were provided.");
    }
    if (replies.some((r) => r.status === "error")) {
      const open = context.commentStore.listOpenCommentIds();
      lines.push(
        open.length
          ? `Open comment ids: ${open.join(", ")}`
          : `There are no open comments.`,
      );
    }
    return {
      type: "tool_result",
      id: request.id,
      result: {
        status: "ok",
        value: [
          {
            type: "text",
            text: lines.join("\n"),
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          },
        ],
        structuredResult: {
          toolName: "reply",
          replies,
        },
      },
      nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
    };
  })();

  return { promise, abort: () => {} };
}

export const spec: ProviderToolSpec = {
  name: "reply" as ToolName,
  description: `Reply to comments the user has left on ranges of buffers (delivered to you in <comment_update> blocks).
Your reply is shown to the user inline, right below the commented range, so keep it short and specific to that comment.
This is a batch: answer every comment you have something to say about in a single tool use.
Replying does not edit the buffer — use the normal editing tools for that.`,
  input_schema: {
    type: "object",
    properties: {
      replies: {
        type: "array",
        description: "One entry per comment you are replying to.",
        items: {
          type: "object",
          properties: {
            commentId: {
              type: "string",
              description: "The id of the comment, e.g. `c3`.",
            },
            text: {
              type: "string",
              description: "Your reply to that comment.",
            },
          },
          required: ["commentId", "text"],
        },
      },
    },
    required: ["replies"],
  },
};

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (!Array.isArray(input.replies)) {
    return { status: "error", error: "expected input.replies to be an array" };
  }
  for (const entry of input.replies) {
    if (typeof entry !== "object" || entry === null) {
      return {
        status: "error",
        error: "expected each entry of input.replies to be an object",
      };
    }
    const reply = entry as { [key: string]: unknown };
    if (typeof reply.commentId !== "string") {
      return {
        status: "error",
        error: "expected input.replies[].commentId to be a string",
      };
    }
    if (typeof reply.text !== "string") {
      return {
        status: "error",
        error: "expected input.replies[].text to be a string",
      };
    }
  }
  return { status: "ok", value: input as Input };
}
