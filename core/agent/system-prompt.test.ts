import { it, expect } from "vitest";
import { createSystemPrompt } from "./system-prompt.ts";
import { withDriver } from "../test/preamble.ts";

it("includes system information in the prompt", async () => {
  await withDriver({}, async (driver) => {
    const systemPrompt = await createSystemPrompt("root", {
      nvim: driver.magenta.nvim,
      cwd: driver.magenta.cwd,
      options: driver.magenta.options,
    });

    // Check that system information is included
    expect(systemPrompt).toContain("# System Information");
    expect(systemPrompt).toContain("- Current time:");
    expect(systemPrompt).toContain("- Operating system:");
    expect(systemPrompt).toContain("- Neovim version:");
    expect(systemPrompt).toContain("- Current working directory:");

    // Verify the platform is included
    expect(systemPrompt).toMatch(/- Operating system: (darwin|linux|win32)/);

    // Verify the timestamp format
    expect(systemPrompt).toMatch(
      /- Current time: \w+ \w+ \d+ \d+ \d+:\d+:\d+ GMT/,
    );

    // Verify cwd is included
    expect(systemPrompt).toContain(
      `- Current working directory: ${driver.magenta.cwd}`,
    );
  });
});
