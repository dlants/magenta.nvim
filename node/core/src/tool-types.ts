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
import type { Result } from "./utils/result.ts";

export type ValidateInput = (
  toolName: unknown,
  input: { [key: string]: unknown },
) => Result<Record<string, unknown>>;
