export type ToolRequestId = string & { __toolRequestId: true };

/** Opaque toolName type. Internally we'll differentiate between static tools and mcp tools, but external to the tool
 * manager, we'll use opaque types.
 */
export type ToolName = string & { __toolName: true };

export type ToolRequest = {
  id: ToolRequestId;
  toolName: ToolName;
  input: unknown;
};

import type { ProviderToolResult } from "./providers/provider-types.ts";
import type * as BashCommand from "./tools/bashCommand.ts";
import type * as Edl from "./tools/edl.ts";
import type * as FindReferences from "./tools/findReferences.ts";
import type * as GetFile from "./tools/getFile.ts";
import type * as Hover from "./tools/hover.ts";
import type * as NvimLua from "./tools/nvimLua.ts";
import type * as Reply from "./tools/reply.ts";
import type * as RunScript from "./tools/run-script.ts";
import type * as SpawnSubagents from "./tools/spawn-subagents.ts";
import type * as ThreadTitle from "./tools/thread-title.ts";
import type { StaticToolName } from "./tools/tool-registry.ts";
import type * as YieldToParent from "./tools/yield-to-parent.ts";
import type { HomeDir, NvimCwd } from "./utils/files.ts";
import type { Result } from "./utils/result.ts";

export type DisplayContext = {
  cwd: NvimCwd;
  homeDir: HomeDir;
};

/** The result of a tool that publishes no structured data of its own, and of
 * tool results reconstructed from the provider's native message array (where
 * the structured data was never serialized). Deliberately carries no tool name:
 * a name here would make `toolName === "some_tool"` checks pass for a value
 * that doesn't have that tool's fields. */
export type GenericStructuredResult = { toolName: "unknown" };

/** The structured result of a tool that publishes one, by tool name. */
export type StructuredResultFor<K extends string> = Extract<
  ToolStructuredResult,
  { toolName: K }
>;

/** Narrow a structured result to a specific tool's shape. */
export function structuredResultFor<
  K extends StructuredResultFor<string>["toolName"],
>(
  result: ToolStructuredResult,
  toolName: K,
): StructuredResultFor<K> | undefined {
  return result.toolName === toolName
    ? (result as StructuredResultFor<K>)
    : undefined;
}

export type ToolStructuredResult =
  | BashCommand.StructuredResult
  | Edl.StructuredResult
  | SpawnSubagents.StructuredResult
  | GetFile.StructuredResult
  | Hover.StructuredResult
  | NvimLua.StructuredResult
  | FindReferences.StructuredResult
  | ThreadTitle.StructuredResult
  | YieldToParent.StructuredResult
  | Reply.StructuredResult
  | RunScript.StructuredResult
  | GenericStructuredResult;

export type CompletedToolInfo = {
  request: ToolRequest;
  result: ProviderToolResult;
  structuredResult: ToolStructuredResult;
};

export type GenericToolRequest<K extends StaticToolName, I> = {
  id: ToolRequestId;
  toolName: K;
  input: I;
};

export type ToolManagerToolMsg = {
  type: "tool-msg";
  msg: {
    id: ToolRequestId;
    toolName: ToolName;
    msg: ToolMsg;
  };
};

export type ToolMsg = { __toolMsg: true };

export type ToolInvocation = {
  promise: Promise<ProviderToolResult>;
  abort: () => void;
};

export type ValidateInput = (
  toolName: unknown,
  input: { [key: string]: unknown },
) => Result<Record<string, unknown>>;
