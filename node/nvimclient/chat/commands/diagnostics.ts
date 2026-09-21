import type { AgentInput } from "../../providers/provider-types.ts";
import { getDiagnostics } from "../../utils/diagnostics.ts";
import type { Command } from "./types.ts";

const createDiagnosticsCommand = (name: string, pattern: RegExp): Command => ({
  name,
  pattern,
  async execute(_match, context): Promise<AgentInput[]> {
    try {
      const diagnostics = await getDiagnostics(
        context.nvim,
        context.cwd,
        context.homeDir,
      );
      return [
        {
          type: "text",
          text: `Current diagnostics:\n${diagnostics}`,
        },
      ];
    } catch (error) {
      context.nvim.logger.error(
        `Failed to fetch diagnostics for message: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [
        {
          type: "text",
          text: `Error fetching diagnostics: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }
  },
});

export const diagCommand: Command = createDiagnosticsCommand(
  "@diag",
  /@diag\b/,
);

export const diagnosticsCommand: Command = createDiagnosticsCommand(
  "@diagnostics",
  /@diagnostics\b/,
);
