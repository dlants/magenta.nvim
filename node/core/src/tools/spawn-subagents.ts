import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentsMap,
  type AgentTier,
  formatAgentsIntroduction,
} from "../agents/agents.ts";
import type { ThreadManager } from "../capabilities/thread-manager.ts";
import type { SubagentConfig, ThreadId } from "../chat-types.ts";
import { provisionContainer } from "../container/provision.ts";
import type { ContainerConfig } from "../container/types.ts";
import type {
  ProviderToolResult,
  ProviderToolSpec,
} from "../providers/provider-types.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "../providers/provider-types.ts";
import type {
  GenericToolRequest,
  ToolInvocation,
  ToolName,
} from "../tool-types.ts";
import type { NvimCwd, UnresolvedFilePath } from "../utils/files.ts";
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
  environment?: "host" | "docker" | "docker_unsupervised";
  directory?: string;
  dockerfile?: string;
  workspacePath?: string;
};

export type Input = {
  sharedPrompt?: string;
  sharedContextFiles?: UnresolvedFilePath[];
  agents: SubagentEntry[];
};

export type ToolRequest = GenericToolRequest<"spawn_subagents", Input>;

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

function resolveSubagentConfig(
  entry: SubagentEntry,
  agents: AgentsMap,
): SubagentConfig {
  const agentType = entry.agentType;

  // Look up agent by name (including "subagent" as fallback)
  const agentDef = agentType ? agents[agentType] : agents["subagent"];
  if (agentDef) {
    return {
      agentName: agentDef.name,
      fastModel: agentDef.fastModel,
      systemPrompt: agentDef.systemPrompt,
      systemReminder: agentDef.systemReminder,
      tier: agentDef.tier,
    };
  }

  // Unknown agent type — treat as leaf
  return { agentName: agentType ?? "subagent", tier: "leaf" as AgentTier };
}

export function execute(
  request: ToolRequest,
  context: {
    threadManager: ThreadManager;
    threadId: ThreadId;
    maxConcurrentSubagents: number;
    requestRender: () => void;
    cwd: NvimCwd;
    agents: AgentsMap;
  },
): ToolInvocation & { progress: SpawnSubagentsProgress } {
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
    if (entry.environment !== undefined) merged.environment = entry.environment;
    if (entry.directory !== undefined) merged.directory = entry.directory;
    if (entry.dockerfile !== undefined) merged.dockerfile = entry.dockerfile;
    if (entry.workspacePath !== undefined)
      merged.workspacePath = entry.workspacePath;

    return merged;
  });

  const progress: SpawnSubagentsProgress = {
    elements: mergedAgents.map((entry) => ({
      entry,
      state: { status: "pending" as const },
    })),
  };

  const abortController = { aborted: false };

  const spawnEntry = async (
    element: SpawnSubagentsProgress["elements"][0],
  ): Promise<void> => {
    if (abortController.aborted) return;

    const entry = element.entry;

    try {
      if (
        entry.environment === "docker" ||
        entry.environment === "docker_unsupervised"
      ) {
        await spawnDockerEntry(element, entry, context);
        return;
      }

      const subagentConfig = resolveSubagentConfig(entry, context.agents);

      const resolvedCwd = entry.directory
        ? resolve(context.cwd, entry.directory)
        : undefined;

      const threadId = await context.threadManager.spawnThread({
        parentThreadId: context.threadId,
        prompt: entry.prompt ?? "",
        threadType: "subagent",
        subagentConfig,
        ...(entry.contextFiles ? { contextFiles: entry.contextFiles } : {}),
        ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
      });

      element.state = { status: "spawned", threadId };
      context.requestRender();
    } catch (e) {
      element.state = {
        status: "spawn-error",
        error: e instanceof Error ? e.message : String(e),
      };
      context.requestRender();
    }
  };

  const spawnDockerEntry = async (
    element: SpawnSubagentsProgress["elements"][0],
    entry: SubagentEntry,
    ctx: typeof context,
  ): Promise<void> => {
    const hostDir = resolve(ctx.cwd, entry.directory ?? ".");

    // Check if dockerfile and workspacePath are defined
    if (
      typeof entry.dockerfile !== "string" ||
      typeof entry.workspacePath !== "string"
    ) {
      element.state = {
        status: "spawn-error",
        error:
          "Docker environment requires 'dockerfile' and 'workspacePath' fields",
      };
      ctx.requestRender();
      return;
    }

    // contextFiles don't work for docker subagents since the container
    // has a separate filesystem. Strip them and add a note to the prompt.
    let prompt = entry.prompt ?? "";
    const contextFiles = entry.contextFiles;
    if (contextFiles && contextFiles.length > 0) {
      const fileList = contextFiles.map((f) => `  - ${f}`).join("\n");
      const note = `Note: The parent agent attempted to include the following context files, but they may not be present on your local Docker filesystem:\n${fileList}\nYou may need to find these files in the workspace or access them via git.\n`;
      prompt = prompt ? `${note}\n${prompt}` : note;
    }

    const containerConfig: ContainerConfig = {
      dockerfile: entry.dockerfile,
      workspacePath: entry.workspacePath,
    };

    element.state = { status: "provisioning", message: "Starting..." };
    ctx.requestRender();

    const subagentConfig = resolveSubagentConfig(entry, ctx.agents);

    const provisionResult = await provisionContainer({
      hostDir,
      containerConfig,
      onProgress: (message) => {
        element.state = { status: "provisioning", message };
        ctx.requestRender();
      },
    });

    const threadId = await ctx.threadManager.spawnThread({
      parentThreadId: ctx.threadId,
      prompt,
      threadType: "docker_root",
      subagentConfig,
      dockerSpawnConfig: {
        containerName: provisionResult.containerName,
        imageName: provisionResult.imageName,
        workspacePath: containerConfig.workspacePath,
        hostDir,
        supervised: entry.environment === "docker_unsupervised",
      },
    });

    element.state = { status: "spawned", threadId };
    ctx.requestRender();
  };

  const promise = (async (): Promise<ProviderToolResult> => {
    try {
      const maxConcurrent = context.maxConcurrentSubagents;

      // Phase 1: Spawn all threads with concurrency control
      let nextIdx = 0;
      const inFlight = new Set<Promise<void>>();

      const startNext = (): void => {
        if (nextIdx >= progress.elements.length || abortController.aborted)
          return;
        const element = progress.elements[nextIdx++];
        const p = spawnEntry(element).then(() => {
          inFlight.delete(p);
        });
        inFlight.add(p);
      };

      while (
        nextIdx < progress.elements.length &&
        inFlight.size < maxConcurrent
      ) {
        startNext();
      }

      while (inFlight.size > 0) {
        await Promise.race(inFlight);
        if (!abortController.aborted) {
          startNext();
        }
      }

      if (abortController.aborted) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Sub-agent execution was aborted",
          },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        };
      }

      // Phase 2: Wait for all spawned threads to yield
      const spawnedElements = progress.elements.filter(
        (
          el,
        ): el is typeof el & {
          state: { status: "spawned"; threadId: ThreadId };
        } => el.state.status === "spawned",
      );

      if (spawnedElements.length === 0) {
        return buildResult(request.id, progress, context.threadManager);
      }

      await new Promise<void>((resolve) => {
        const checkAllYielded = () => {
          if (abortController.aborted) {
            resolve();
            return;
          }
          const allDone = spawnedElements.every((el) => {
            const result = context.threadManager.getThreadResult(
              el.state.threadId,
            );
            return result.status === "done";
          });
          if (allDone) {
            resolve();
          }
        };

        for (const el of spawnedElements) {
          context.threadManager.onThreadYielded(
            el.state.threadId,
            checkAllYielded,
          );
        }

        // Check immediately in case all threads already yielded
        checkAllYielded();
      });

      if (abortController.aborted) {
        return {
          type: "tool_result",
          id: request.id,
          result: {
            status: "error",
            error: "Sub-agent execution was aborted",
          },
          nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
        };
      }

      return buildResult(request.id, progress, context.threadManager);
    } catch (e) {
      return {
        type: "tool_result",
        id: request.id,
        result: {
          status: "error",
          error: e instanceof Error ? e.message : String(e),
        },
        nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
      };
    }
  })();

  return {
    promise,
    abort: () => {
      abortController.aborted = true;
    },
    progress,
  };
}

function buildResult(
  requestId: ToolRequest["id"],
  progress: SpawnSubagentsProgress,
  threadManager: ThreadManager,
): ProviderToolResult {
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

    const threadResult = threadManager.getThreadResult(item.state.threadId);
    if (threadResult.status === "pending") {
      failCount++;
      resultText += `❌ ${truncatedPrompt}:\nthread did not complete\n\n`;
      agents.push({
        prompt: item.entry.prompt ?? "",
        threadId: item.state.threadId,
        ok: false,
      });
      continue;
    }

    const result = threadResult.result;
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
      value: [{ type: "text", text: resultText, nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX }],
      structuredResult: {
        toolName: "spawn_subagents" as const,
        agents,
      },
    },
    nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
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
    // Thread: show leaf agents + thread agents (thread agents need docker)
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
                  "Agent type for this sub-agent. Selects the agent personality/system-prompt. Use 'subagent' for general tasks, or a custom agent name.",
              },
              environment: {
                type: "string",
                enum: ["host", "docker", "docker_unsupervised"],
                description:
                  "Where the sub-agent runs. 'host' (default) runs locally on the host machine, 'docker'/'docker_unsupervised' runs in an isolated container. Requires 'dockerfile' and 'workspacePath' fields.",
              },
              directory: {
                type: "string",
                description:
                  "Host directory to spawn the docker container from. Defaults to '.' (current working directory). The directory must contain a Dockerfile (at the path specified by 'dockerfile'). For host environments, sets the working directory for the sub-agent.",
              },
              dockerfile: {
                type: "string",
                description:
                  "Path to the Dockerfile, relative to directory. Required for docker/docker_unsupervised environments.",
              },
              workspacePath: {
                type: "string",
                description:
                  "Working directory for the agent inside the container. Required for docker/docker_unsupervised environments.",
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
const VALID_ENVIRONMENTS = ["host", "docker", "docker_unsupervised"] as const;

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

    if (agent.environment !== undefined) {
      if (
        typeof agent.environment !== "string" ||
        !VALID_ENVIRONMENTS.includes(
          agent.environment as (typeof VALID_ENVIRONMENTS)[number],
        )
      ) {
        return {
          status: "error",
          error: `expected agents[${i}].environment to be one of ${VALID_ENVIRONMENTS.join(", ")} but it was ${JSON.stringify(agent.environment)}`,
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

    if (agent.dockerfile !== undefined) {
      if (typeof agent.dockerfile !== "string") {
        return {
          status: "error",
          error: `expected agents[${i}].dockerfile to be a string but it was ${JSON.stringify(agent.dockerfile)}`,
        };
      }
    }

    if (agent.workspacePath !== undefined) {
      if (typeof agent.workspacePath !== "string") {
        return {
          status: "error",
          error: `expected agents[${i}].workspacePath to be a string but it was ${JSON.stringify(agent.workspacePath)}`,
        };
      }
    }

    if (
      agent.environment === "docker" ||
      agent.environment === "docker_unsupervised"
    ) {
      if (
        typeof agent.dockerfile !== "string" ||
        typeof agent.workspacePath !== "string"
      ) {
        return {
          status: "error",
          error: `agents[${i}] with docker environment requires 'dockerfile' and 'workspacePath' fields`,
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
