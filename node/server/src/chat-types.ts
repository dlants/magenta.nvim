import type { AgentTier } from "./agents/agents.ts";
import type { ThinkingEffort } from "./provider-options.ts";
import type { NativeMessageIdx } from "./providers/provider-types.ts";

export type Role = "user" | "assistant";

export type ThreadId = string & { __threadId: true };

const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isThreadId(value: unknown): value is ThreadId {
  return typeof value === "string" && UUIDV7_PATTERN.test(value);
}

export type ScriptInvocationId = string & { __scriptInvocationId: true };

export type MessageIdx = number & { __messageIdx: true };
export type ContentBlockIdx = number & { __contentBlockIdx: true };

export type ThreadType =
  | "subagent"
  | "compact"
  | "root"
  | "docker_root"
  | "reflect";

/** Text as it appeared in a display buffer (decoration, placeholders and
 * summaries included). Never compare it against message content. */
export type DisplayBufferText = string & { __displayBufferText: true };

export type ReflectAnchor = {
  /** Index into the source's ProviderMessage[]. */
  messageIdx: MessageIdx;
  /** Content block within that message. */
  contentIdx: ContentBlockIdx;
  reflectionText: DisplayBufferText;
};

/** A reflection on the whole thread, anchored to the last message that
 * existed when it was started. */
export type MessageAnchor = { messageIdx: MessageIdx };
export type ReflectionOriginAnchor = ReflectAnchor | MessageAnchor;
export function isSelectionAnchor(
  anchor: ReflectionOriginAnchor,
): anchor is ReflectAnchor {
  return "reflectionText" in anchor;
}
/** How a thread was derived from another one it is not a subagent of. */
export type ThreadOrigin =
  | {
      type: "fork";
      sourceThreadId: ThreadId;
      nativeMessageIdx: NativeMessageIdx;
    }
  | {
      type: "reflect";
      sourceThreadId: ThreadId;
      anchor: ReflectionOriginAnchor;
    };

export type SubagentConfig = {
  agentName?: string | undefined;
  fastModel?: boolean | undefined;
  thinkingModel?: boolean | undefined;
  systemPrompt?: string | undefined;
  systemReminder?: string | undefined;
  tier?: AgentTier | undefined;
  effort?: ThinkingEffort | undefined;
};
