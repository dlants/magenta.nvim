import type { ProviderMessageContent } from "../../providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "@magenta/core";
import { getBuffersList } from "../../utils/listBuffers.ts";
import type { Command } from "./types.ts";

const createBuffersCommand = (name: string, pattern: RegExp): Command => ({
  name,
  pattern,
  async execute(_match, context): Promise<ProviderMessageContent[]> {
    try {
      const buffersList = await getBuffersList(context.nvim);
      return [
        {
          type: "text",
          text: `Current buffers list:\n${buffersList}`,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ];
    } catch (error) {
      context.nvim.logger.error(
        `Failed to fetch buffers list for message: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [
        {
          type: "text",
          text: `Error fetching buffers list: ${error instanceof Error ? error.message : String(error)}`,
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        },
      ];
    }
  },
});

export const bufCommand: Command = createBuffersCommand("@buf", /@buf\b/);

export const buffersCommand: Command = createBuffersCommand(
  "@buffers",
  /@buffers\b/,
);
