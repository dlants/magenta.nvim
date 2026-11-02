import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentsMap,
  type AgentTier,
  formatAgentsIntroduction,
} from "../agents/agents.ts";
import type { ThreadManager } from "../capabilities/thread-manager.ts";
import type { SubagentConfig, ThreadId } from "../chat-types.ts";
import type { ProviderToolSpec } from "../providers/provider-types.ts";
import { ABORTED, type ThreadOutcome } from "../thread-api.ts";
import type {
  ExecutedToolResult,
  ExecutingToolInvocation,
  GenericToolRequest,
  ToolName,
} from "../tool-types.ts";
import type { ProjectDir, UnresolvedFilePath } from "../utils/files.ts";
import { toProjectDir } from "../utils/files.ts";
import type { Result } from "../utils/result.ts";

const SPAWN_SUBAGENTS_BASE_DESCRIPTION = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "spawn-subagents-description.md",
  ),
  "utf-8",
);

export type SubagentEntry = {
  prompt?: string;
  contextFiles?: UnresolvedFilePath[];
  agentType?: string;
  directory?: string;
};

export type Input = {
  sharedPrompt?: string;
  sharedContextFiles?: UnresolvedFilePath[];
  agents: SubagentEntry[];
};

export type ToolRequest = GenericToolRequest<"spawn_subagents", Input>;

export type PartialSubagentEntry = {
  agentType?: string;
  directory?: string;
  prompt?: string;
  contextFiles?: string[];
};

export type PartialSpawnSubagentsInput = {
  sharedPrompt?: string;
  sharedContextFiles?: string[];
  agents: PartialSubagentEntry[];
};

/**
 * Tolerant recursive-descent parser that turns a partial (possibly truncated)
 * JSON string for a spawn_subagents input into a best-effort view object.
 * Never throws on any prefix of a valid input — returns whatever is known so far,
 * including a trailing partial string token.
 */
export function parsePartialSpawnSubagentsInput(
  inputJson: string,
): PartialSpawnSubagentsInput {
  const s = inputJson;
  const result: PartialSpawnSubagentsInput = { agents: [] };
  const EOF = Symbol("eof");
  let pos = 0;

  function skipWs(): void {
    while (pos < s.length && /\s/.test(s[pos])) pos++;
    if (pos >= s.length) throw EOF;
  }

  function parseString(): string {
    skipWs();
    if (s[pos] !== '"') throw EOF;
    pos++; // opening quote
    let value = "";
    while (pos < s.length) {
      const c = s[pos++];
      if (c === "\\") {
        if (pos >= s.length) return value; // truncated escape
        const e = s[pos++];
        switch (e) {
          case "n":
            value += "\n";
            break;
          case "t":
            value += "\t";
            break;
          case "r":
            value += "\r";
            break;
          case '"':
            value += '"';
            break;
          case "\\":
            value += "\\";
            break;
          case "/":
            value += "/";
            break;
          case "u": {
            const hex = s.slice(pos, pos + 4);
            if (hex.length < 4) return value; // truncated unicode escape
            value += String.fromCharCode(parseInt(hex, 16));
            pos += 4;
            break;
          }
          default:
            value += e;
        }
      } else if (c === '"') {
        return value; // closed
      } else {
        value += c;
      }
    }
    return value; // truncated, no closing quote
  }

  function parseStringArray(target: string[]): void {
    skipWs();
    if (s[pos] !== "[") throw EOF;
    pos++;
    for (;;) {
      skipWs();
      if (s[pos] === "]") {
        pos++;
        return;
      }
      if (s[pos] === ",") {
        pos++;
        continue;
      }
      if (s[pos] === '"') {
        target.push(parseString());
      } else {
        throw EOF;
      }
    }
  }

  function skipValue(): void {
    skipWs();
    const c = s[pos];
    if (c === '"') {
      parseString();
      return;
    }
    if (c === "[") {
      skipArray();
      return;
    }
    if (c === "{") {
      skipObject();
      return;
    }
    while (pos < s.length && !",]}".includes(s[pos]) && !/\s/.test(s[pos])) {
      pos++;
    }
    if (pos >= s.length) throw EOF;
  }

  function skipArray(): void {
    pos++; // [
    for (;;) {
      skipWs();
      if (s[pos] === "]") {
        pos++;
        return;
      }
      if (s[pos] === ",") {
        pos++;
        continue;
      }
      skipValue();
    }
  }

  function skipObject(): void {
    pos++; // {
    for (;;) {
      skipWs();
      if (s[pos] === "}") {
        pos++;
        return;
      }
      if (s[pos] === ",") {
        pos++;
        continue;
      }
      if (s[pos] !== '"') throw EOF;
      parseString(); // key
      skipWs();
      if (s[pos] === ":") pos++;
      skipValue();
    }
  }

  function parseAgentEntry(entry: PartialSubagentEntry): void {
    pos++; // {
    for (;;) {
      skipWs();
      if (s[pos] === "}") {
        pos++;
        return;
      }
      if (s[pos] === ",") {
        pos++;
        continue;
      }
      if (s[pos] !== '"') throw EOF;
      const key = parseString();
      skipWs();
      if (s[pos] === ":") pos++;
      switch (key) {
        case "prompt":
          entry.prompt = parseString();
          break;
        case "agentType":
          entry.agentType = parseString();
          break;
        case "directory":
          entry.directory = parseString();
          break;
        case "contextFiles": {
          const arr: string[] = [];
          entry.contextFiles = arr; // attach before filling
          parseStringArray(arr);
          break;
        }
        default:
          skipValue();
      }
    }
  }

  function parseAgents(target: PartialSubagentEntry[]): void {
    skipWs();
    if (s[pos] !== "[") throw EOF;
    pos++;
    for (;;) {
      skipWs();
      if (s[pos] === "]") {
        pos++;
        return;
      }
      if (s[pos] === ",") {
        pos++;
        continue;
      }
      if (s[pos] === "{") {
        const entry: PartialSubagentEntry = {};
        target.push(entry); // attach before filling
        parseAgentEntry(entry);
      } else {
        throw EOF;
      }
    }
  }

  function parseTopLevel(): void {
    skipWs();
    if (s[pos] !== "{") return;
    pos++;
    for (;;) {
      skipWs();
      if (s[pos] === "}") {
        pos++;
        return;
      }
      if (s[pos] === ",") {
        pos++;
        continue;
      }
      if (s[pos] !== '"') throw EOF;
      const key = parseString();
      skipWs();
      if (s[pos] === ":") pos++;
      switch (key) {
        case "sharedPrompt":
          result.sharedPrompt = parseString();
          break;
        case "sharedContextFiles": {
          const arr: string[] = [];
          result.sharedContextFiles = arr; // attach before filling
          parseStringArray(arr);
          break;
        }
        case "agents":
          parseAgents(result.agents);
          break;
        default:
          skipValue();
      }
    }
  }

  try {
    parseTopLevel();
  } catch (e) {
    if (e !== EOF) throw e;
  }

  return result;
}

export type SubagentElementProgress =
  | { status: "pending" }
  | { status: "provisioning"; message: string }
  | { status: "spawned"; threadId: ThreadId }
  | { status: "spawn-error"; error: string };

export type SpawnSubagentsProgress = {
  elements: Array<{
    entry: SubagentEntry;
    state: SubagentElementProgress;
  }>;
};

export type StructuredResult = {
  toolName: "spawn_subagents";
  agents: Array<{
    prompt: string;
    threadId?: ThreadId;
    ok: boolean;
    responseBody?: string;
  }>;
};

export function resolveSubagentConfig(
  entry: SubagentEntry,
  agents: AgentsMap,
): SubagentConfig {
  const agentType = entry.agentType;

  // Look up agent by name (including "subagent" as fallback)
  const agentDef = agentType ? agents[agentType] : agents.subagent;
  if (agentDef) {
    return {
      agentName: agentDef.name,
      fastModel: agentDef.fastModel,
      thinkingModel: agentDef.thinkingModel,
      systemPrompt: agentDef.systemPrompt,
      systemReminder: agentDef.systemReminder,
      tier: agentDef.tier,
      effort: agentDef.effort,
    };
  }

  // Unknown agent type — treat as leaf
  return { agentName: agentType ?? "subagent", tier: "leaf" as AgentTier };
}

function requireAbsoluteDirectory(directory: string): ProjectDir {
  if (!isAbsolute(directory)) {
    throw new Error(`directory must be an absolute path, got "${directory}"`);
  }
  return toProjectDir(directory);
}

export function execute(
  request: ToolRequest,
  context: {
    threadManager: ThreadManager;
    threadId: ThreadId;
    maxConcurrentSubagents: number;
    maxConcurrentFastSubagents: number;
    requestRender: () => void;
    agents: AgentsMap;
  },
): ExecutingToolInvocation & { progress: SpawnSubagentsProgress } {
  const input = request.input;

  // Merge sharedPrompt and sharedContextFiles into each entry
  const mergedAgents: SubagentEntry[] = input.agents.map((entry) => {
    const merged: SubagentEntry = {};

    const mergedPrompt = input.sharedPrompt
      ? entry.prompt
        ? `${input.sharedPrompt}\n\n${entry.prompt}`
        : input.sharedPrompt
      : entry.prompt;
    if (mergedPrompt !== undefined) {
      merged.prompt = mergedPrompt;
    }

    if (input.sharedContextFiles || entry.contextFiles) {
      merged.contextFiles = [
        ...((input.sharedContextFiles ?? []) as UnresolvedFilePath[]),
        ...((entry.contextFiles ?? []) as UnresolvedFilePath[]),
      ];
    }

    if (entry.agentType !== undefined) merged.agentType = entry.agentType;
    if (entry.directory !== undefined) merged.directory = entry.directory;

    return merged;
  });

  const progress: SpawnSubagentsProgress = {
    elements: mergedAgents.map((entry) => ({
      entry,
      state: { status: "pending" as const },
    })),
  };

  const abortController = {
    aborted: false,
    /** Woken by `abort()` so waiters unblock without a yield. */
    listeners: new Set<() => void>(),
  };
  /** Each child's outcome, kept here because the tool result is assembled
   * after every element has finished. */
  const threadResults = new Map<ThreadId, ThreadOutcome>();

  const spawnEntry = async (
    element: SpawnSubagentsProgress["elements"][0],
  ): Promise<void> => {
    if (abortController.aborted) return;

    const entry = element.entry;

    try {
      const subagentConfig = resolveSubagentConfig(entry, context.agents);

      const projectDir =
        entry.directory !== undefined
          ? requireAbsoluteDirectory(entry.directory)
          : undefined;

      const threadId = await context.threadManager.spawnThread({
        parentThreadId: context.threadId,
        prompt: entry.prompt ?? "",
        threadType: "subagent",
        subagentConfig,
        ...(entry.contextFiles ? { contextFiles: entry.contextFiles } : {}),
        ...(projectDir ? { projectDir } : {}),
      });

      element.state =
        threadId === ABORTED
          ? { status: "spawn-error", error: "thread creation was aborted" }
          : { status: "spawned", threadId };
      context.requestRender();
    } catch (e) {
      element.state = {
        status: "spawn-error",
        error: e instanceof Error ? e.message : String(e),
      };
      context.requestRender();
    }
  };

  const isFastElement = (
    element: SpawnSubagentsProgress["elements"][0],
  ): boolean =>
    resolveSubagentConfig(element.entry, context.agents).fastModel === true;

  // Runs an element end-to-end: spawns it, then waits until its thread
  // actually yields. This is what makes an element "live" for concurrency
  // purposes, so the next queued element isn't launched until a slot frees up.
  const runElement = async (
    element: SpawnSubagentsProgress["elements"][0],
  ): Promise<void> => {
    await spawnEntry(element);
    if (abortController.aborted || element.state.status !== "spawned") {
      return;
    }
    const threadId = element.state.threadId;
    // A promise, not a poll plus a callback registry: a thread that finished
    // before we got here still resolves, so there is no edge to miss.
    await new Promise<void>((resolve) => {
      const onAbort = () => resolve();
      abortController.listeners.add(onAbort);
      if (abortController.aborted) {
        resolve();
        return;
      }
      context.threadManager.awaitThreadResult(threadId).then(
        (result) => {
          threadResults.set(threadId, result);
          abortController.listeners.delete(onAbort);
          resolve();
        },
        () => {
          abortController.listeners.delete(onAbort);
          resolve();
        },
      );
    });
  };

  const runQueue = async (
    elements: SpawnSubagentsProgress["elements"],
    limit: number,
  ): Promise<void> => {
    let nextIdx = 0;
    const inFlight = new Set<Promise<void>>();

    const startNext = (): void => {
      if (nextIdx >= elements.length || abortController.aborted) return;
      const element = elements[nextIdx++];
      const p = runElement(element).then(() => {
        inFlight.delete(p);
      });
      inFlight.add(p);
    };

    while (nextIdx < elements.length && inFlight.size < limit) {
      startNext();
    }

    while (inFlight.size > 0) {
      await Promise.race(inFlight);
      if (!abortController.aborted) {
        startNext();
      }
    }
  };

  const promise = (async (): Promise<ExecutedToolResult> => {
    try {
      const fastElements = progress.elements.filter(isFastElement);
      const otherElements = progress.elements.filter(
        (el) => !isFastElement(el),
      );

      await Promise.all([
        runQueue(fastElements, context.maxConcurrentFastSubagents),
        runQueue(otherElements, context.maxConcurrentSubagents),
      ]);

      if (abortController.aborted) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Sub-agent execution was aborted",
          },
        };
      }

      return buildResult(request.id, progress, threadResults);
    } catch (e) {
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: e instanceof Error ? e.message : String(e),
        },
      };
    }
  })();

  return {
    promise,
    abort: () => {
      abortController.aborted = true;
      for (const listener of [...abortController.listeners]) {
        listener();
      }
    },
    progress,
  };
}

function buildResult(
  requestId: ToolRequest["id"],
  progress: SpawnSubagentsProgress,
  threadResults: ReadonlyMap<ThreadId, ThreadOutcome>,
): ExecutedToolResult {
  const agents: StructuredResult["agents"] = [];
  let successCount = 0;
  let failCount = 0;

  let resultText = "All sub-agents completed:\n\n";

  for (const item of progress.elements) {
    const truncatedPrompt = truncatePrompt(item.entry.prompt ?? "(no prompt)");

    if (item.state.status === "spawn-error") {
      failCount++;
      resultText += `❌ ${truncatedPrompt}:\n${item.state.error}\n\n`;
      agents.push({
        prompt: item.entry.prompt ?? "",
        ok: false,
      });
      continue;
    }

    if (item.state.status !== "spawned") {
      failCount++;
      resultText += `❌ ${truncatedPrompt}:\nnever spawned\n\n`;
      agents.push({
        prompt: item.entry.prompt ?? "",
        ok: false,
      });
      continue;
    }

    const threadResult = threadResults.get(item.state.threadId);
    if (threadResult === undefined) {
      failCount++;
      resultText += `❌ ${truncatedPrompt}:\nthread did not complete\n\n`;
      agents.push({
        prompt: item.entry.prompt ?? "",
        threadId: item.state.threadId,
        ok: false,
      });
      continue;
    }

    const result: Result<string> =
      threadResult.type === "yielded"
        ? {
            status: "ok",
            value: String(threadResult.value.result),
          }
        : { status: "error", error: threadResult.reason };
    if (result.status === "ok") {
      successCount++;
      resultText += `✅ ${truncatedPrompt}:\n${result.value}\n\n`;
      agents.push({
        prompt: item.entry.prompt ?? "",
        threadId: item.state.threadId,
        ok: true,
        responseBody: result.value,
      });
    } else {
      failCount++;
      resultText += `❌ ${truncatedPrompt}:\n${result.error}\n\n`;
      agents.push({
        prompt: item.entry.prompt ?? "",
        threadId: item.state.threadId,
        ok: false,
      });
    }
  }

  const totalLine = `Total: ${progress.elements.length}\nSuccessful: ${successCount}\nFailed: ${failCount}\n\n`;
  resultText =
    resultText.slice(0, "All sub-agents completed:\n\n".length) +
    totalLine +
    resultText.slice("All sub-agents completed:\n\n".length);

  return {
    type: "tool_result",
    id: requestId,
    result: {
      status: "ok",
      value: [
        {
          type: "text",
          text: resultText,
        },
      ],
      structuredResult: {
        toolName: "spawn_subagents" as const,
        agents,
      },
    },
  };
}

function truncatePrompt(prompt: string, maxLen: number = 80): string {
  const singleLine = prompt.replace(/\n/g, " ");
  return singleLine.length > maxLen
    ? `${singleLine.substring(0, maxLen)}...`
    : singleLine;
}

export function getSpec(
  agents: AgentsMap,
  currentTier?: AgentTier,
): ProviderToolSpec {
  const agentNames = Object.keys(agents);
  let filteredAgentNames: string[];

  if (currentTier === undefined) {
    // Root: show all agents
    filteredAgentNames = agentNames;
  } else if (currentTier === "thread") {
    // Thread: show leaf agents + thread agents
    filteredAgentNames = agentNames.filter((name) => {
      const tier = agents[name].tier;
      return tier === "leaf" || tier === "thread";
    });
  } else if (currentTier === "orchestrator") {
    // Orchestrator: show all agents
    filteredAgentNames = agentNames;
  } else {
    // leaf shouldn't have spawn_subagents, but if it does, show nothing
    filteredAgentNames = [];
  }

  const allAgentTypes = filteredAgentNames;

  const agentsDescription = formatAgentsIntroduction(agents);
  const description = SPAWN_SUBAGENTS_BASE_DESCRIPTION + agentsDescription;

  return {
    name: "spawn_subagents" as ToolName,
    description,
    input_schema: {
      type: "object",
      properties: {
        sharedPrompt: {
          type: "string",
          description:
            "Optional prompt text prepended to every sub-agent's individual prompt. When provided, per-agent prompt becomes optional.",
        },
        sharedContextFiles: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of file paths provided as context to every sub-agent, merged with per-agent contextFiles.",
        },
        agents: {
          type: "array",
          description:
            "Array of sub-agent configurations to run in parallel. Each entry specifies a prompt and optional settings.",
          items: {
            type: "object",
            properties: {
              prompt: {
                type: "string",
                description:
                  "The sub-agent prompt. Optional if sharedPrompt is provided.",
              },
              contextFiles: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional list of file paths to provide as context to this sub-agent.",
              },
              agentType: {
                type: "string",
                enum: allAgentTypes,
                description:
                  "Runner type for this sub-agent. Selects the agent personality/system-prompt. Use 'subagent' for general tasks, or a custom agent name.",
              },
              directory: {
                type: "string",
                description:
                  "Absolute directory to start the sub-agent from (its options, skills and agents load from there). Defaults to the directory this thread was started from.",
              },
            },
          },
          minItems: 1,
        },
      },
      required: ["agents"],
    },
  };
}

export function validateInput(input: {
  [key: string]: unknown;
}): Result<Input> {
  if (input.sharedPrompt !== undefined) {
    if (typeof input.sharedPrompt !== "string") {
      return {
        status: "error",
        error: `expected sharedPrompt to be a string but it was ${JSON.stringify(input.sharedPrompt)}`,
      };
    }
  }

  if (input.sharedContextFiles !== undefined) {
    if (!Array.isArray(input.sharedContextFiles)) {
      return {
        status: "error",
        error: `expected sharedContextFiles to be an array but it was ${JSON.stringify(input.sharedContextFiles)}`,
      };
    }
    if (
      !input.sharedContextFiles.every(
        (item: unknown) => typeof item === "string",
      )
    ) {
      return {
        status: "error",
        error: "expected all items in sharedContextFiles to be strings",
      };
    }
  }

  if (!Array.isArray(input.agents)) {
    return {
      status: "error",
      error: `expected req.input.agents to be an array but it was ${JSON.stringify(input.agents)}`,
    };
  }

  if (input.agents.length === 0) {
    return {
      status: "error",
      error: "agents array cannot be empty",
    };
  }

  const hasSharedPrompt =
    typeof input.sharedPrompt === "string" && input.sharedPrompt.length > 0;

  for (let i = 0; i < input.agents.length; i++) {
    const agent = input.agents[i] as Record<string, unknown>;

    if (agent.prompt !== undefined && typeof agent.prompt !== "string") {
      return {
        status: "error",
        error: `expected agents[${i}].prompt to be a string but it was ${JSON.stringify(agent.prompt)}`,
      };
    }

    if (!hasSharedPrompt && typeof agent.prompt !== "string") {
      return {
        status: "error",
        error: `expected agents[${i}].prompt to be a string (or provide sharedPrompt) but it was ${JSON.stringify(agent.prompt)}`,
      };
    }

    if (agent.contextFiles !== undefined) {
      if (!Array.isArray(agent.contextFiles)) {
        return {
          status: "error",
          error: `expected agents[${i}].contextFiles to be an array but it was ${JSON.stringify(agent.contextFiles)}`,
        };
      }
      if (
        !agent.contextFiles.every((item: unknown) => typeof item === "string")
      ) {
        return {
          status: "error",
          error: `expected all items in agents[${i}].contextFiles to be strings`,
        };
      }
    }

    if (agent.agentType !== undefined) {
      if (typeof agent.agentType !== "string") {
        return {
          status: "error",
          error: `expected agents[${i}].agentType to be a string but it was ${JSON.stringify(agent.agentType)}`,
        };
      }
    }

    if (agent.directory !== undefined) {
      if (typeof agent.directory !== "string") {
        return {
          status: "error",
          error: `expected agents[${i}].directory to be a string but it was ${JSON.stringify(agent.directory)}`,
        };
      }
    }
  }

  return {
    status: "ok",
    value: {
      ...(typeof input.sharedPrompt === "string"
        ? { sharedPrompt: input.sharedPrompt }
        : {}),
      ...(Array.isArray(input.sharedContextFiles)
        ? {
            sharedContextFiles:
              input.sharedContextFiles as UnresolvedFilePath[],
          }
        : {}),
      agents: input.agents as SubagentEntry[],
    },
  };
}
