import { describe, expect, it } from "vitest";
import { buildSystemReminder } from "./system-reminders.ts";

describe("buildSystemReminder", () => {
  it("returns a single combined block when multiple kinds are requested for root", () => {
    const reminder = buildSystemReminder({
      threadType: "root",
      kinds: ["subsequent", "bashSummary"],
    });
    expect(reminder).toBeDefined();
    expect(reminder!.startsWith("<system-reminder>")).toBe(true);
    expect(reminder!.endsWith("</system-reminder>")).toBe(true);
    expect((reminder!.match(/<system-reminder>/g) ?? []).length).toBe(1);
    expect((reminder!.match(/<\/system-reminder>/g) ?? []).length).toBe(1);
    // Subsequent body
    expect(reminder).toContain("Remember the skills");
    expect(reminder).toContain("bash_command");
    expect(reminder).toContain("EDL");
    expect(reminder).toContain("sub-agents");
    // Bash summary body
    expect(reminder).toContain("bash_summarizer");
    expect(reminder).toContain("log file");
  });

  it("returns just the subsequent reminder for root when only subsequent is requested", () => {
    const reminder = buildSystemReminder({
      threadType: "root",
      kinds: ["subsequent"],
    });
    expect(reminder).toBeDefined();
    expect(reminder).toContain("<system-reminder>");
    expect(reminder).toContain("Remember the skills");
    expect(reminder).not.toContain("bash_summarizer");
  });

  it("returns just the bash summary reminder when only bashSummary is requested", () => {
    const reminder = buildSystemReminder({
      threadType: "root",
      kinds: ["bashSummary"],
    });
    expect(reminder).toBeDefined();
    expect(reminder).toContain("<system-reminder>");
    expect(reminder).toContain("bash_summarizer");
    expect(reminder).not.toContain("Remember the skills");
  });

  it("returns undefined when no kinds are requested", () => {
    expect(
      buildSystemReminder({ threadType: "root", kinds: [] }),
    ).toBeUndefined();
  });

  it("root subsequent reminder does not include yield_to_parent", () => {
    const reminder = buildSystemReminder({
      threadType: "root",
      kinds: ["subsequent"],
    });
    expect(reminder).not.toContain("yield_to_parent");
  });

  it("docker_root subsequent reminder includes the docker yield_to_parent instruction", () => {
    const reminder = buildSystemReminder({
      threadType: "docker_root",
      kinds: ["subsequent"],
    });
    expect(reminder).toBeDefined();
    expect(reminder).toContain("Docker container");
    expect(reminder).toContain("yield_to_parent");
  });

  it("subagent subsequent reminder includes the subagent yield_to_parent instruction", () => {
    const reminder = buildSystemReminder({
      threadType: "subagent",
      kinds: ["subsequent"],
    });
    expect(reminder).toBeDefined();
    expect(reminder).toContain("yield_to_parent");
  });

  it("subagent subsequent reminder appends a custom systemReminder when provided", () => {
    const reminder = buildSystemReminder({
      threadType: "subagent",
      subagentConfig: { systemReminder: "Custom subagent guidance" },
      kinds: ["subsequent"],
    });
    expect(reminder).toBeDefined();
    expect(reminder).toContain("Custom subagent guidance");
  });

  it("returns undefined for compact thread regardless of requested kinds", () => {
    expect(
      buildSystemReminder({
        threadType: "compact",
        kinds: ["subsequent", "bashSummary"],
      }),
    ).toBeUndefined();
  });
});
