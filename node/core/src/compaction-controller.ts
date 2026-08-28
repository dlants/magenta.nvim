import type { ProviderMessage } from "./providers/provider-types.ts";

export type CompactionStep = {
  chunkIndex: number;
  totalChunks: number;
  messages: ProviderMessage[];
};

export type CompactionRecord = {
  steps: CompactionStep[];
  finalSummary: string | undefined;
};

export type CompactionResult =
  | {
      type: "complete";
      summary: string;
      steps: CompactionStep[];
      nextPrompt: string | undefined;
    }
  | { type: "error"; steps: CompactionStep[] };

export interface CompactionController {
  chunks: string[];
  steps: CompactionStep[];
  nextPrompt: string | undefined;

  start(messages: ReadonlyArray<ProviderMessage>, nextPrompt?: string): void;
}
