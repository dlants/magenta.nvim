import { describe, expect, test } from "vitest";
import { createLogWriter } from "./shell-utils.ts";

describe("createLogWriter", () => {
  test("writes after end() are no-ops and do not throw", () => {
    const logWriter = createLogWriter(
      "logwriter-test-thread",
      `logwriter-test-${Date.now()}`,
      "echo hi",
    );

    logWriter.write("stdout", "before end");
    logWriter.end();

    // Simulate late data events from a killed detached process group.
    expect(() => {
      logWriter.write("stdout", "after end");
      logWriter.writeRaw("after end raw");
      logWriter.end();
    }).not.toThrow();
  });
});
