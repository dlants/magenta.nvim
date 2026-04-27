import { describe, expect, it } from "vitest";
import {
  getBashSummaryReminder,
  getSubsequentReminder,
} from "./system-reminders.ts";

describe("getSubsequentReminder", () => {
  it("root reminder includes skills, bash, edl, explore reminders", () => {
    const reminder = getSubsequentReminder("root");
    expect(reminder).toContain("<system-reminder>");
    expect(reminder).toContain("Remember the skills");
    expect(reminder).toContain("bash_command");
    expect(reminder).toContain("EDL");
    expect(reminder).toContain("sub-agents");
  });

  it("root reminder does not include yield_to_parent", () => {
    const reminder = getSubsequentReminder("root");
    expect(reminder).not.toContain("yield_to_parent");
  });
});

describe("getBashSummaryReminder", () => {
  it("returns a reminder mentioning bash_summarizer and the log file for root threads", () => {
    const reminder = getBashSummaryReminder("root");
    expect(reminder).toBeDefined();
    expect(reminder).toContain("<system-reminder>");
    expect(reminder).toContain("bash_summarizer");
    expect(reminder).toContain("log file");
  });

  it("returns a reminder for docker_root threads", () => {
    const reminder = getBashSummaryReminder("docker_root");
    expect(reminder).toBeDefined();
    expect(reminder).toContain("<system-reminder>");
  });

  it("returns a reminder for subagent threads", () => {
    const reminder = getBashSummaryReminder("subagent");
    expect(reminder).toBeDefined();
    expect(reminder).toContain("<system-reminder>");
  });

  it("returns undefined for compact threads", () => {
    expect(getBashSummaryReminder("compact")).toBeUndefined();
  });
});
