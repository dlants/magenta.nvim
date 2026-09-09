import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "@magenta/server";
import type { ProviderMessageContent } from "../../providers/provider-types.ts";
import type { Command } from "./types.ts";

const IMPLEMENT_PLAN_INSTRUCTION = `Implement the current plan. Work through the plan's stages in order, verifying each stage before moving on to the next.`;

const PLAN_MAINTENANCE_REMINDER = `You are implementing a plan. As you work, keep the plan file updated: record progress as stages are completed, and note any implementation choices, decisions, or deviations from the plan so the plan stays an accurate reflection of the work.`;

export const implementPlanCommand: Command = {
  name: "@implementplan",
  description: "Instruct the agent to implement the current plan",
  pattern: /@implementplan\b/,
  systemReminder: PLAN_MAINTENANCE_REMINDER,
  execute(): Promise<ProviderMessageContent[]> {
    return Promise.resolve([
      {
        type: "text",
        text: IMPLEMENT_PLAN_INSTRUCTION,
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      },
    ]);
  },
};
