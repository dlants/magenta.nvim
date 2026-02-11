import type { ProviderToolSpec } from "../agent/provider-types.ts";
import type { ToolName } from "./types.ts";
import { spec as edlSpec } from "./specs/edl.ts";
import { spec as bashCommandSpec } from "./specs/bash-command.ts";

export { type ToolRequestId, type CompletedToolInfo } from "./types.ts";

export const TOOL_SPEC_MAP: Record<string, ProviderToolSpec> = {
  edl: edlSpec,
  bash_command: bashCommandSpec,
};

export function getToolSpecs(
  additionalSpecs?: ProviderToolSpec[],
): ProviderToolSpec[] {
  const specs = Object.values(TOOL_SPEC_MAP);
  if (additionalSpecs) {
    specs.push(...additionalSpecs);
  }
  return specs;
}

export function getToolSpec(toolName: ToolName): ProviderToolSpec | undefined {
  return TOOL_SPEC_MAP[toolName as string];
}
