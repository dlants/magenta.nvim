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

export type GenericStructuredResult = { toolName: ToolName };

export type ToolStructuredResult =
  | BashCommand.StructuredResult
  | Edl.StructuredResult
  | SpawnSubagents.StructuredResult
  | GetFile.StructuredResult
  | Hover.StructuredResult
  | FindReferences.StructuredResult
  | ThreadTitle.StructuredResult
  | YieldToParent.StructuredResult
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
