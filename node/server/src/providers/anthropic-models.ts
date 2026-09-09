import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../logger.ts";

/** Resolve `output_config` for adaptive-thinking models. Emits a single warn
 * and returns undefined when the current model does not support adaptive
 * thinking but the caller requested an effort level. */
export function resolveOutputConfig(
  model: string,
  thinking:
    | {
        enabled: boolean;
        budgetTokens?: number;
        displayThinking?: boolean;
        effort?: "low" | "medium" | "high" | "xhigh" | "max";
      }
    | undefined,
  logger: Logger,
  isBedrock = false,
): Anthropic.Messages.OutputConfig | undefined {
  if (!thinking?.effort) return undefined;
  if (!supportsAdaptiveThinking(model, isBedrock)) {
    logger.warn(
      `thinking.effort is only supported on adaptive-thinking models (Opus 4.7+, Sonnet 4.6+); ignoring effort=${thinking.effort} on model ${model}`,
    );
    return undefined;
  }
  return { effort: thinking.effort };
}

// Map a high-level effort level to a concrete budget_tokens value for the
// legacy thinking.type=enabled path (used on AWS Bedrock, which doesn't
// support adaptive thinking or output_config).
export function effortToBudgetTokens(
  effort: "low" | "medium" | "high" | "xhigh" | "max" | undefined,
): number {
  switch (effort) {
    case "low":
      return 2048;
    case "medium":
      return 8192;
    case "high":
      return 16000;
    case "xhigh":
      return 24000;
    case "max":
      return 32000;
    default:
      return 1024;
  }
}

// Opus 4.7+ and Sonnet 4.6+ (and any later major version, e.g. opus-5,
// sonnet-6, ...) require adaptive thinking instead of budget_tokens.
// The isBedrock parameter is retained for older Bedrock-hosted models that
// still need the legacy path, but Opus 4.7+ on Bedrock now requires adaptive.
export function supportsAdaptiveThinking(
  model: string,
  _isBedrock = false,
): boolean {
  const normalized = normalizeModelName(model);
  if (normalized.match(/^claude-opus-4-([7-9]|\d{2,})/)) return true;
  if (normalized.match(/^claude-opus-([5-9]|\d{2,})(-|$)/)) return true;
  if (normalized.match(/^claude-sonnet-4-([6-9]|\d{2,})/)) return true;
  if (normalized.match(/^claude-sonnet-([5-9]|\d{2,})(-|$)/)) return true;
  return false;
}

function normalizeModelName(model: string): string {
  const match = model.match(/claude-[a-z0-9.-]+/);
  return match ? match[0] : model;
}
export function getContextWindowForModel(model: string): number {
  model = normalizeModelName(model);
  // Claude 3+ models all have 200K context windows
  if (model.match(/^claude-(opus-4|sonnet-4|haiku-4|3|4)/)) {
    return 200_000;
  }

  // Legacy Claude 2.x models - 100K context window
  if (model.match(/^claude-2\./)) {
    return 100_000;
  }

  // Default for unknown models - conservative 200K
  return 200_000;
}
export function getMaxTokensForModel(model: string): number {
  model = normalizeModelName(model);
  // Opus 5+, Sonnet 5+ (and any later major version) - use high limits
  if (
    model.match(/^claude-opus-([5-9]|\d{2,})(-|$)/) ||
    model.match(/^claude-sonnet-([5-9]|\d{2,})(-|$)/)
  ) {
    return 64000;
  }

  // Claude 4.5 models (Opus, Sonnet, Haiku) - use high limits
  if (
    model.match(/^claude-(opus-4-5|opus-4-6|opus-4-7|sonnet-4-5|haiku-4-5)/)
  ) {
    return 32000;
  }

  // Claude 4 models - use high limits
  if (model.match(/^claude-(opus-4|sonnet-4|4-opus|4-sonnet)/)) {
    return 32000;
  }

  // Claude 3.7 Sonnet - supports up to 128k with beta header
  if (model.match(/^claude-3-7-sonnet/)) {
    return 32000; // Conservative default, can be increased to 128k with beta header
  }

  // Claude 3.5 Sonnet - 8k limit
  if (model.match(/^claude-3-5-sonnet/)) {
    return 8192;
  }

  // Claude 3.5 Haiku - 8k limit (same as Sonnet)
  if (model.match(/^claude-3-5-haiku/)) {
    return 8192;
  }

  // Legacy Claude 3 models (Opus, Sonnet, Haiku) - 4k limit
  if (model.match(/^claude-3-(opus|sonnet|haiku)/)) {
    return 4096;
  }

  // Legacy Claude 2.x models - 4k limit
  if (model.match(/^claude-2\./)) {
    return 4096;
  }

  // Default for unknown models - conservative 4k limit
  return 4096;
}

export const CLAUDE_CODE_SPOOF_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";
