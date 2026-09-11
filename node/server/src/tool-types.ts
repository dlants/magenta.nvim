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

import type {
  ProviderToolResult,
  ProviderToolResultContent,
} from "./providers/provider-types.ts";
import type * as BashCommand from "./tools/bashCommand.ts";
import type * as Edl from "./tools/edl.ts";
import type * as FindReferences from "./tools/findReferences.ts";
import type * as GetFile from "./tools/getFile.ts";
import type * as Hover from "./tools/hover.ts";
import type * as NvimLua from "./tools/nvimLua.ts";
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

/** The structured result of a tool that publishes one, by tool name. */
export type StructuredResultFor<K extends string> = Extract<
  ToolStructuredResult,
  { toolName: K }
>;

/** Narrow a structured result to a specific tool's shape. */
export function structuredResultFor<
  K extends StructuredResultFor<string>["toolName"],
>(
  result: ToolStructuredResult | undefined,
  toolName: K,
): StructuredResultFor<K> | undefined {
  return result?.toolName === toolName
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
  | RunScript.StructuredResult;

export type CompletedToolInfo = {
  request: ToolRequest;
  result: ProviderToolResult;
  structuredResult: ToolStructuredResult | undefined;
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

/** What a tool's `execute` resolves to: the wire result plus the structured
 * payload that never goes to the model. The thread strips the structured half
 * before the agent sees it. */
export type ExecutedToolResult = Omit<ProviderToolResult, "result"> & {
  result:
    | {
        status: "ok";
        value: ProviderToolResultContent[];
        structuredResult?: ToolStructuredResult;
      }
    | { status: "error"; error: string };
};

/** What the agent drives: wire results only. */
export type ToolInvocation = {
  promise: Promise<ProviderToolResult>;
  abort: () => void;
};

/** What a tool produces, seen only by the thread. */
export type ExecutingToolInvocation = Omit<ToolInvocation, "promise"> & {
  promise: Promise<ExecutedToolResult>;
};

export type ValidateInput = (
  toolName: unknown,
  input: { [key: string]: unknown },
) => Result<Record<string, unknown>>;

/** A tool invocation as the loop's owner tracks it: the live handle, its
 * latest progress, and its result once it lands. */
export type ActiveToolEntry = {
  handle: ToolInvocation;
  progress: unknown;
  toolName: ToolName;
  request: ToolRequest;
  result?: ProviderToolResult;
};
