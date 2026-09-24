import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { expect, it, vi } from "vitest";
import { type AgentsMap, loadAgents } from "../agents/agents.ts";
import type { MockStream } from "../providers/mock-anthropic-client.ts";
import { type Harness, withHarness } from "../test/harness.ts";
import { noopLogger } from "../test-helpers.ts";
import type { Thread } from "../thread.ts";
import { SubagentSupervisor } from "../thread-supervisor.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { pollUntil } from "../utils/async.ts";
import type { NvimCwd } from "../utils/files.ts";

/** The built-in agent definitions shipped in the server source tree. */
const builtinAgents = loadAgents({
  cwd: "/project" as NvimCwd,
  logger: noopLogger,
  options: {
    agentsPaths: [path.join(import.meta.dirname, "../agents")],
    skillsPaths: [],
  },
});

function spawn(
  stream: MockStream,
  id: string,
  agents: { prompt: string; agentType?: string }[],
) {
  stream.respond({
    stopReason: "tool_use",
    text: "Spawning.",
    toolRequests: [
      {
        status: "ok",
        value: {
          id: id as ToolRequestId,
          toolName: "spawn_subagents" as ToolName,
          input: { agents },
        },
      },
    ],
  });
}

function yieldResult(stream: MockStream, id: string, result: string) {
  stream.respond({
    stopReason: "tool_use",
    text: "Done.",
    toolRequests: [
      {
        status: "ok",
        value: {
          id: id as ToolRequestId,
          toolName: "yield_to_parent" as ToolName,
          input: { result },
        },
      },
    ],
  });
}

function childThread(h: Harness, parent: Thread): Thread {
  const record = h.session
    .listThreads()
    .find((t) => t.parentThreadId === parent.id);
  if (record?.state !== "initialized") throw new Error("no child thread yet");
  return record.thread;
}

function toolResultText(stream: MockStream, id: string): string {
  const block = stream.messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find(
      (b): b is Anthropic.ToolResultBlockParam =>
        b.type === "tool_result" && b.tool_use_id === id,
    );
  if (!block) throw new Error(`no tool_result for ${id}`);
  return JSON.stringify(block.content);
}

it("waits for subagent completion and returns result", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "Spawn a subagent.");
    spawn(await h.nextStream(), "test-blocking", [
      { prompt: "Do a task and report back" },
    ]);
    yieldResult(
      await h.streamWithText("Do a task"),
      "yield-1",
      "Found the answer: 42",
    );
    const parentFollowup = await h.streamWithText("Found the answer: 42");
    expect(toolResultText(parentFollowup, "test-blocking")).toContain(
      "Found the answer: 42",
    );
  }));

it("yield_to_parent submits tool result back to subagent thread", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "Spawn a subagent.");
    spawn(await h.nextStream(), "spawn-1", [{ prompt: "Do the task" }]);
    yieldResult(
      await h.streamWithText("Do the task"),
      "yield-1",
      "Task result: success",
    );
    const child = childThread(h, thread);
    const yielded = await pollUntil(() => {
      if (!child.yielded) throw new Error("not yielded yet");
      return child.yielded;
    });
    expect(yielded.value.result).toBe("Task result: success");
  }));

it("supervisor resultPrefix is prepended to yield response", () =>
  withHarness({}, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "Spawn a subagent.");
    spawn(await h.nextStream(), "spawn-1", [{ prompt: "Do the task" }]);
    const subagentStream = await h.streamWithText("Do the task");
    const child = childThread(h, thread);
    const supervisor = child.turnSupervisors.find(
      (s): s is SubagentSupervisor => s instanceof SubagentSupervisor,
    );
    if (!supervisor) throw new Error("expected a SubagentSupervisor");
    vi.spyOn(supervisor, "onYield").mockResolvedValue({
      type: "accept",
      resultPrefix: "[Worker branch: magenta/worker-test123]",
    });
    yieldResult(subagentStream, "yield-prefix", "Completed all changes");
    const yielded = await pollUntil(() => {
      if (!child.yielded) throw new Error("not yielded yet");
      return child.yielded;
    });
    expect(yielded.resultPrefix).toContain("magenta/worker-test123");
    expect(yielded.value).toEqual({ result: "Completed all changes" });
    expect(child.tornDown).toBe(true);
  }));

it("uses fast model for subagents when agentType is 'fast-edit'", () =>
  withHarness(
    { agents: builtinAgents, options: { maxConcurrentSubagents: 1 } },
    async (h) => {
      Object.assign(h.host.profile, {
        thinking: { enabled: true, budgetTokens: 1024 },
      });
      const { thread } = await h.createRoot();
      void h.send(thread, "Use spawn_subagents with fast agent type.");
      const parent = await h.nextStream();
      expect(parent.params.thinking).toEqual({
        type: "enabled",
        budget_tokens: 1024,
      });
      spawn(parent, "test-fast", [
        { prompt: "Process this element quickly", agentType: "fast-edit" },
      ]);
      const sub = await h.streamWithText("Process this element quickly");
      expect(sub.params.model).toBe(h.host.profile.fastModel);
      expect(sub.params.thinking).toBeUndefined();
    },
  ));

it("uses thinking model for subagents when agentType is 'think'", () =>
  withHarness(
    { agents: builtinAgents, options: { maxConcurrentSubagents: 1 } },
    async (h) => {
      Object.assign(h.host.profile, { thinkingModel: "mock-thinking" });
      const { thread } = await h.createRoot();
      void h.send(thread, "Use spawn_subagents with think agent.");
      const parent = await h.nextStream();
      expect(parent.params.model).toBe(h.host.profile.model);
      spawn(parent, "test-think", [
        { prompt: "Reason carefully about this", agentType: "think" },
      ]);
      const sub = await h.streamWithText("Reason carefully about this");
      expect(sub.params.model).toBe("mock-thinking");
      expect(sub.params.thinking).toBeDefined();
    },
  ));

const codeReview: AgentsMap = {
  "code-review": {
    name: "code-review",
    description: "Reviews code changes for correctness and style",
    systemPrompt:
      "You are a code review agent.\n\n<system_reminder>\nAlways check for proper error handling and type safety.\n</system_reminder>",
    systemReminder: "Always check for proper error handling and type safety.",
    fastModel: true,
    thinkingModel: undefined,
    effort: undefined,
    tier: "leaf",
  },
};

it("discovers custom agent, uses its system prompt/reminder, and respects fastModel", () =>
  withHarness(
    { agents: codeReview, files: { "/project/poem.txt": "a poem" } },
    async (h) => {
      Object.assign(h.host.profile, {
        thinking: { enabled: true, budgetTokens: 1024 },
      });
      const { thread } = await h.createRoot();
      void h.send(thread, "Review my code changes.");
      const parent = await h.nextStream();
      const spawnTool = parent.params.tools?.find(
        (t) => "name" in t && t.name === "spawn_subagents",
      );
      expect(JSON.stringify(spawnTool)).toContain('"code-review"');
      expect(JSON.stringify(spawnTool)).toContain(
        "Reviews code changes for correctness and style",
      );
      spawn(parent, "spawn-review", [
        {
          prompt: "Review the changes in src/main.ts",
          agentType: "code-review",
        },
      ]);
      const sub = await h.streamWithText("Review the changes");
      expect(sub.systemPrompt).toContain("You are a code review agent");
      expect(sub.systemPrompt).toContain(
        "Always check for proper error handling and type safety",
      );
      expect(sub.params.model).toBe(h.host.profile.fastModel);
      expect(sub.params.thinking).toBeUndefined();
      sub.respond({
        stopReason: "tool_use",
        text: "Let me check the file.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "get-file-1" as ToolRequestId,
              toolName: "get_files" as ToolName,
              input: { files: [{ filePath: "poem.txt" }] },
            },
          },
        ],
      });
      const autoRespond = await h.streamWithText("get-file-1");
      const reminder = JSON.stringify(autoRespond.messages.at(-1));
      expect(reminder).toContain(
        "Always check for proper error handling and type safety",
      );
      expect(reminder).toContain("yield_to_parent");
      yieldResult(autoRespond, "yield-review", "Code looks good");
      await h.streamWithText("Code looks good");
    },
  ));

it("built-in explore agent is discoverable in tool spec", () =>
  withHarness({ agents: builtinAgents }, async (h) => {
    const { thread } = await h.createRoot();
    void h.send(thread, "Hello");
    const stream = await h.nextStream();
    const spawnTool = stream.params.tools?.find(
      (t) => "name" in t && t.name === "spawn_subagents",
    ) as
      | {
          input_schema: {
            properties: {
              agents: {
                items: { properties: { agentType: { enum: string[] } } };
              };
            };
          };
        }
      | undefined;
    const agentTypes =
      spawnTool?.input_schema.properties.agents.items.properties.agentType.enum;
    expect(agentTypes).toContain("explore");
    expect(agentTypes).not.toContain("plan");
  }));
