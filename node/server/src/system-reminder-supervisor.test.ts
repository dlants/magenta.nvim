import { describe, expect, it } from "vitest";
import type { ContextTracker } from "./capabilities/context-tracker.ts";
import type {
  NativeMessageIdx,
  ToolResults,
} from "./providers/provider-types.ts";
import { SystemReminderSupervisor } from "./system-reminder-supervisor.ts";
import type { RequestContext } from "./thread-supervisor.ts";
import type {
  CompletedToolInfo,
  ToolName,
  ToolRequestId,
  ToolStructuredResult,
} from "./tool-types.ts";
import type { AbsFilePath } from "./utils/files.ts";

const INTERVAL = 2000;
const TOOL_ID = "tool-1" as ToolRequestId;

function makeSupervisor(contextFiles: ContextTracker["files"] = {}) {
  const completedTools = new Map<ToolRequestId, CompletedToolInfo>();
  const supervisor = SystemReminderSupervisor.create({
    threadType: "root",
    contextTracker: { files: contextFiles },
    getCompletedTools: () => completedTools,
  });
  const record = (
    id: ToolRequestId,
    structuredResult: ToolStructuredResult,
  ) => {
    completedTools.set(id, {
      request: {
        id,
        toolName: structuredResult.toolName as ToolName,
        input: {},
      },
      result: {
        type: "tool_result",
        id,
        result: { status: "ok", value: [] },
        nativeMessageIdx: 0 as NativeMessageIdx,
      },
      structuredResult,
    });
  };
  return { record, supervisor };
}

function request(
  outputTokenCount: number,
  nativeMessageIdx = 0 as NativeMessageIdx,
  status: RequestContext["status"] = "pending",
): RequestContext {
  return status === "pending"
    ? {
        status,
        inputTokenCount: 0,
        outputTokenCount,
        nativeMessageIdx,
      }
    : {
        status,
        reason: { kind: "suspend", message: "halt" },
        inputTokenCount: 0,
        outputTokenCount,
        nativeMessageIdx,
      };
}

function results(): ToolResults {
  return new Map([[TOOL_ID, { status: "ok" as const, value: [] }]]);
}

async function reminderText(
  supervisor: SystemReminderSupervisor,
  tokens: number,
  nativeMessageIdx = 0 as NativeMessageIdx,
  status: RequestContext["status"] = "pending",
) {
  const action = await supervisor.onBeforeRequest(
    request(tokens, nativeMessageIdx, status),
  );
  if (action.type !== "inject") return undefined;
  return action.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

describe("SystemReminderSupervisor token gate", () => {
  it("fires on the opening request, then stays silent below the interval", async () => {
    const { supervisor } = makeSupervisor();
    expect(await reminderText(supervisor, 0)).toContain("Remember the skills");
    expect(await reminderText(supervisor, INTERVAL - 1)).toBeUndefined();
    expect(await reminderText(supervisor, INTERVAL)).toContain(
      "Remember the skills",
    );
  });

  it("measures from the last standing reminder retained by a clone", async () => {
    const { supervisor } = makeSupervisor();
    await reminderText(supervisor, 0, 1 as NativeMessageIdx);
    await reminderText(supervisor, INTERVAL, 3 as NativeMessageIdx);

    const throughFirst = SystemReminderSupervisor.clone({
      source: supervisor,
      nativeMessageIdx: 1 as NativeMessageIdx,
      contextTracker: { files: {} },
      getCompletedTools: () => new Map(),
    });
    expect(
      await reminderText(throughFirst, INTERVAL * 2 - 1, 4 as NativeMessageIdx),
    ).toContain("Remember the skills");

    const throughSecond = SystemReminderSupervisor.clone({
      source: supervisor,
      nativeMessageIdx: 3 as NativeMessageIdx,
      contextTracker: { files: {} },
      getCompletedTools: () => new Map(),
    });
    expect(
      await reminderText(
        throughSecond,
        INTERVAL * 2 - 1,
        4 as NativeMessageIdx,
      ),
    ).toBeUndefined();
  });
});

describe("SystemReminderSupervisor bash latch", () => {
  it("fires on the next request after abbreviated output, then clears", async () => {
    const { record, supervisor } = makeSupervisor();
    record(TOOL_ID, {
      toolName: "bash_command",
      exitCode: 0,
      signal: undefined,
      logFilePath: "/tmp/log",
      logFileLineCount: 100,
      logFileCharCount: 1000,
      outputText: "trimmed",
      wasAbbreviated: true,
    });
    supervisor.onToolResults(results(), 1 as NativeMessageIdx);
    expect(await reminderText(supervisor, 0, 1 as NativeMessageIdx)).toContain(
      "bash_summarizer",
    );
    expect(
      await reminderText(supervisor, 0, 2 as NativeMessageIdx),
    ).toBeUndefined();
  });

  it("retains an arm through its index and a firing through later clone points", async () => {
    const { record, supervisor } = makeSupervisor();
    await reminderText(supervisor, 0, 0 as NativeMessageIdx);
    record(TOOL_ID, {
      toolName: "bash_command",
      exitCode: 0,
      signal: undefined,
      logFilePath: "/tmp/log",
      logFileLineCount: 100,
      logFileCharCount: 1000,
      outputText: "trimmed",
      wasAbbreviated: true,
    });
    supervisor.onToolResults(results(), 2 as NativeMessageIdx);
    await reminderText(supervisor, 1, 4 as NativeMessageIdx);

    const throughArm = SystemReminderSupervisor.clone({
      source: supervisor,
      nativeMessageIdx: 2 as NativeMessageIdx,
      contextTracker: { files: {} },
      getCompletedTools: () => new Map(),
    });
    expect(await reminderText(throughArm, 1, 5 as NativeMessageIdx)).toContain(
      "bash_summarizer",
    );

    for (const clonePoint of [4, 5]) {
      const throughFire = SystemReminderSupervisor.clone({
        source: supervisor,
        nativeMessageIdx: clonePoint as NativeMessageIdx,
        contextTracker: { files: {} },
        getCompletedTools: () => new Map(),
      });
      expect(
        await reminderText(throughFire, 1, 6 as NativeMessageIdx),
      ).toBeUndefined();
    }
  });

  it("drops a bash reminder armed after the clone point", async () => {
    const { record, supervisor } = makeSupervisor();
    await reminderText(supervisor, 0, 0 as NativeMessageIdx);
    record(TOOL_ID, {
      toolName: "bash_command",
      exitCode: 0,
      signal: undefined,
      logFilePath: "/tmp/log",
      logFileLineCount: 100,
      logFileCharCount: 1000,
      outputText: "trimmed",
      wasAbbreviated: true,
    });
    supervisor.onToolResults(results(), 2 as NativeMessageIdx);

    const clone = SystemReminderSupervisor.clone({
      source: supervisor,
      nativeMessageIdx: 1 as NativeMessageIdx,
      contextTracker: { files: {} },
      getCompletedTools: () => new Map(),
    });
    expect(await reminderText(clone, 1, 3 as NativeMessageIdx)).toBeUndefined();
  });
});

describe("SystemReminderSupervisor activated reminders", () => {
  it("retains activations through an inclusive clone point and drops later ones", async () => {
    const { supervisor } = makeSupervisor();
    supervisor.activateReminder("before", 1 as NativeMessageIdx);
    supervisor.activateReminder("after", 3 as NativeMessageIdx);

    const clone = SystemReminderSupervisor.clone({
      source: supervisor,
      nativeMessageIdx: 1 as NativeMessageIdx,
      contextTracker: { files: {} },
      getCompletedTools: () => new Map(),
    });
    expect(clone.activeReminders).toEqual(new Set(["before"]));
    const text = await reminderText(clone, 0, 2 as NativeMessageIdx);
    expect(text).toContain("before");
    expect(text).not.toContain("after");
  });

  it("rewinds a get_files activation by its result message index", async () => {
    const { record, supervisor } = makeSupervisor();
    record(TOOL_ID, {
      toolName: "get_files",
      files: [
        {
          filePath: "/repo/skill.md" as AbsFilePath,
          lineCount: 1,
          systemReminder: "pet the cat",
          isError: false,
        },
      ],
    });
    supervisor.onToolResults(results(), 4 as NativeMessageIdx);

    const before = SystemReminderSupervisor.clone({
      source: supervisor,
      nativeMessageIdx: 3 as NativeMessageIdx,
      contextTracker: { files: {} },
      getCompletedTools: () => new Map(),
    });
    const through = SystemReminderSupervisor.clone({
      source: supervisor,
      nativeMessageIdx: 4 as NativeMessageIdx,
      contextTracker: { files: {} },
      getCompletedTools: () => new Map(),
    });
    expect(before.activeReminders).toEqual(new Set());
    expect(through.activeReminders).toEqual(new Set(["pet the cat"]));
  });

  it("dedupes a transient reminder against the same text in a context file", async () => {
    const path = "/repo/context.md" as AbsFilePath;
    const { supervisor } = makeSupervisor({
      [path]: {
        agentView: {
          type: "text",
          content: "<system_reminder>pet the cat</system_reminder>",
        },
      },
    });
    supervisor.activateReminder("pet the cat", 0 as NativeMessageIdx);
    const text = (await reminderText(supervisor, 0)) ?? "";
    expect(text.match(/pet the cat/g)?.length).toBe(1);
  });
});

describe("SystemReminderSupervisor suspension", () => {
  it("does not consume standing or bash reminders on a suspended request", async () => {
    const { record, supervisor } = makeSupervisor();
    record(TOOL_ID, {
      toolName: "bash_command",
      exitCode: 0,
      signal: undefined,
      logFilePath: "/tmp/log",
      logFileLineCount: 100,
      logFileCharCount: 1000,
      outputText: "trimmed",
      wasAbbreviated: true,
    });
    supervisor.onToolResults(results(), 0 as NativeMessageIdx);

    expect(
      await reminderText(supervisor, 0, 1 as NativeMessageIdx, "suspended"),
    ).toBeUndefined();
    const delivered = await reminderText(supervisor, 0, 1 as NativeMessageIdx);
    expect(delivered).toContain("Remember the skills");
    expect(delivered).toContain("bash_summarizer");
  });
});
