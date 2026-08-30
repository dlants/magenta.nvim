import { describe, expect, it } from "vitest";
import type { ContextTracker } from "./capabilities/context-tracker.ts";
import type { ToolResults } from "./providers/provider-types.ts";
import { SystemReminderSupervisor } from "./system-reminder-supervisor.ts";
import type { RequestContext } from "./thread-supervisor.ts";
import type { ToolRequestId, ToolStructuredResult } from "./tool-types.ts";
import type { AbsFilePath } from "./utils/files.ts";

const INTERVAL = 2000;

function makeSupervisor(contextFiles: ContextTracker["files"] = {}) {
  return new SystemReminderSupervisor({
    threadType: "root",
    contextTracker: { files: contextFiles },
  });
}

function request(outputTokenCount: number): RequestContext {
  return {
    inputTokenCount: 0,
    outputTokenCount,
  };
}

function results(structured: ToolStructuredResult): ToolResults {
  return new Map([
    [
      "tool-1" as ToolRequestId,
      { status: "ok" as const, value: [], structuredResult: structured },
    ],
  ]);
}

function reminderText(supervisor: SystemReminderSupervisor, tokens: number) {
  const action = supervisor.onBeforeRequest(request(tokens));
  if (action.type !== "inject") return undefined;
  return action.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

describe("SystemReminderSupervisor token gate", () => {
  it("fires on the opening request, then stays silent below the interval", () => {
    const supervisor = makeSupervisor();
    expect(reminderText(supervisor, 0)).toContain("Remember the skills");
    expect(reminderText(supervisor, INTERVAL - 1)).toBeUndefined();
    expect(reminderText(supervisor, INTERVAL)).toContain("Remember the skills");
  });

  it("only resets the counter when the reminder fires", () => {
    const supervisor = makeSupervisor();
    expect(reminderText(supervisor, 0)).toBeDefined();
    expect(reminderText(supervisor, INTERVAL)).toBeDefined();
    expect(reminderText(supervisor, INTERVAL * 2 - 1)).toBeUndefined();
    expect(reminderText(supervisor, INTERVAL * 2)).toBeDefined();
  });
});

describe("SystemReminderSupervisor bash latch", () => {
  it("fires on the next request after abbreviated output, then clears", () => {
    const supervisor = makeSupervisor();
    supervisor.onToolResults(
      results({
        toolName: "bash_command",
        exitCode: 0,
        signal: undefined,
        logFilePath: "/tmp/log",
        logFileLineCount: 100,
        logFileCharCount: 1000,
        outputText: "trimmed",
        wasAbbreviated: true,
      }),
    );
    // The opening request carries the standing reminder too; drain it first.
    expect(reminderText(supervisor, 0)).toContain("bash_summarizer");
    expect(reminderText(supervisor, 0)).toBeUndefined();
  });
});

describe("SystemReminderSupervisor extra reminders", () => {
  it("dedupes a transient reminder against the same text in a context file", () => {
    const path = "/repo/context.md" as AbsFilePath;
    const supervisor = makeSupervisor({
      [path]: {
        agentView: {
          type: "text",
          content: "<system_reminder>pet the cat</system_reminder>",
        },
      },
    });
    supervisor.onToolResults(
      results({
        toolName: "get_files",
        files: [
          {
            filePath: path,
            lineCount: 1,
            systemReminder: "pet the cat",
            isError: false,
          },
        ],
      }),
    );
    const text = reminderText(supervisor, 0) ?? "";
    expect(text.match(/pet the cat/g)?.length).toBe(1);
  });
});
