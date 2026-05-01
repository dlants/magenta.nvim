import { getQuickfixList, quickfixListToString } from "../../nvim/nvim.ts";
import type { ProviderMessageContent } from "../../providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "@magenta/core";
import type { Command } from "./types.ts";

const createQuickfixCommand = (name: string, pattern: RegExp): Command => ({
  name,
  pattern,
  async execute(_match, context): Promise<ProviderMessageContent[]> {
    try {
      const qflist = await getQuickfixList(context.nvim);
      const quickfixStr = await quickfixListToString(qflist, context.nvim);
      return [
        {
          type: "text",
          text: `Current quickfix list:\n${quickfixStr}`,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ];
    } catch (error) {
      context.nvim.logger.error(
        `Failed to fetch quickfix list for message: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [
        {
          type: "text",
          text: `Error fetching quickfix list: ${error instanceof Error ? error.message : String(error)}`,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ];
    }
  },
});

export const qfCommand: Command = createQuickfixCommand("@qf", /@qf\b/);

export const quickfixCommand: Command = createQuickfixCommand(
  "@quickfix",
  /@quickfix\b/,
);
