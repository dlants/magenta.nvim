import type { AgentTier } from "./agents/agents.ts";
import type { ThinkingEffort } from "./provider-options.ts";

export type Role = "user" | "assistant";

export type ThreadId = string & { __threadId: true };

const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isThreadId(value: unknown): value is ThreadId {
  return typeof value === "string" && UUIDV7_PATTERN.test(value);
}

export type MessageIdx = number & { __messageIdx: true };

export type ThreadType = "subagent" | "compact" | "root" | "docker_root";

export type SubagentConfig = {
  agentName?: string | undefined;
  fastModel?: boolean | undefined;
  thinkingModel?: boolean | undefined;
  systemPrompt?: string | undefined;
  systemReminder?: string | undefined;
  tier?: AgentTier | undefined;
  effort?: ThinkingEffort | undefined;
};
