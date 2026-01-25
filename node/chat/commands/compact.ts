import type { Command } from "./types.ts";
import type { ProviderMessageContent } from "../../providers/provider-types.ts";

export const compactCommand: Command = {
  name: "@compact",
  pattern: /@compact\b/,
  description: "Compact the conversation thread and continue with a new prompt",
  execute(_match, _context): Promise<ProviderMessageContent[]> {
    // The compact command doesn't add content directly, it's handled by the thread
    // This is a placeholder that will be handled specially in thread.ts
    return Promise.resolve([]);
  },
};
