import fs from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { withNvimClient } from "../../test/preamble";

describe("src/logger.test.ts", () => {
  const logFilePath = resolve(`/tmp/magenta-test/test-logging.log`);

  beforeEach(async () => {
    try {
      await fs.unlink(logFilePath);
    } catch {
      // ok if file doesn't exist
    }
  });

  it("logs messages in correct format and order", async () => {
    await withNvimClient(
      async (nvim) => {
        // Add various log messages at different levels
        nvim.logger.error("Error level message");
        nvim.logger.warn("Warning level message");
        nvim.logger.info("Info level message");
        nvim.logger.debug("Debug level message");

        // Wait for logs to be written (winston may be async)
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Read log file and verify contents
        const logContent = await fs.readFile(logFilePath, "utf-8");

        // Split lines and check each log entry individually
        const logLines = logContent.trim().split("\n");

        expect(logLines.length, `logContent: ${logContent}`).toBe(3);

        // Parse and verify each line

        const logs: { level: string; message: string; timestamp: string }[] =
          logLines.map(
            (line) =>
              JSON.parse(line) as {
                level: string;
                message: string;
                timestamp: string;
              },
          );

        // Check error message
        expect(logs[0].level).toBe("error");
        expect(logs[0].message).toBe("Error level message");
        expect(logs[0].timestamp).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );

        // Check warn message
        expect(logs[1].level).toBe("warn");
        expect(logs[1].message).toBe("Warning level message");
        expect(logs[1].timestamp).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );

        // Check info message
        expect(logs[2].level).toBe("info");
        expect(logs[2].message).toBe("Info level message");
        expect(logs[2].timestamp).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );

        // Check that debug messages don't appear (set log level to info)
        const debugEntries = logs.filter((log) => log.level === "debug");
        expect(debugEntries.length).toBe(0);
      },
      { logFile: logFilePath, logLevel: "info", overrideLogger: false },
    );
  });
});
