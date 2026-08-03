import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadId, ThreadType } from "../chat-types.ts";
import type { Logger } from "../logger.ts";
import type { OpenAIAuth } from "../openai-auth.ts";
import type { ProviderProfile } from "../provider-options.ts";
import { ThreadCore, type ThreadCoreContext } from "../thread-core.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { validateInput } from "../tools/helpers.ts";
import type { MCPToolManager } from "../tools/mcp/manager.ts";
import { pollUntil } from "../utils/async.ts";
import { MockOpenAIClient } from "./mock-openai-client.ts";
import { OpenAIProvider } from "./openai.ts";
import { getProvider } from "./provider.ts";
import { PLACEHOLDER_NATIVE_MESSAGE_IDX } from "./provider-types.ts";
import type { SystemPrompt } from "./system-prompt.ts";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  trace: () => {},
} as Logger;

function createProvider(client?: MockOpenAIClient): OpenAIProvider {
  const provider = new OpenAIProvider(noopLogger, validateInput, {
    apiKeyEnvVar: "MAGENTA_TEST_OPENAI_KEY",
  });
  if (client) {
    provider.client = client as unknown as OpenAIProvider["client"];
  }
  return provider;
}

function createThreadCore(): { core: ThreadCore; client: MockOpenAIClient } {
  const client = new MockOpenAIClient();
  const provider = createProvider(client);
  const context: ThreadCoreContext = {
    logger: noopLogger,
    profile: {
      name: "openai-test",
      provider: "openai",
      model: "gpt-5.4",
    } as ProviderProfile,
    cwd: "/tmp" as ThreadCoreContext["cwd"],
    homeDir: "/home" as ThreadCoreContext["homeDir"],
    threadType: "subagent" as ThreadType,
    systemPrompt: "test system prompt" as unknown as SystemPrompt,
    systemInfo: {
      timestamp: "Mon Jan 01 2024 00:00:00 GMT+0000",
      platform: "linux",
      neovimVersion: "0.10.0",
      cwd: "/tmp" as ThreadCoreContext["cwd"],
    },
    mcpToolManager: {
      serverMap: {},
      getToolSpecs: () => [],
    } as unknown as MCPToolManager,
    threadManager: {
      getThread: () => undefined,
      getThreads: () => [],
    } as unknown as ThreadCoreContext["threadManager"],
    fileIO: {
      readFile: async () => "",
      writeFile: async () => {},
      fileExists: async () => false,
    } as unknown as ThreadCoreContext["fileIO"],
    shell: {
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    } as unknown as ThreadCoreContext["shell"],
    gitClient: {
      getState: async () => undefined,
    } as unknown as ThreadCoreContext["gitClient"],
    lspClient: {} as unknown as ThreadCoreContext["lspClient"],
    availableCapabilities: new Set(),
    environmentConfig: { type: "local" },
    maxConcurrentSubagents: 1,
    maxConcurrentFastSubagents: 8,
    getAgents: () => ({}),
    getProvider: () => provider,
    conversationLogBaseDir: path.join(os.tmpdir(), "magenta-test-archive"),
  };
  return { core: new ThreadCore("openai-thread" as ThreadId, context), client };
}

describe("OpenAI provider wiring", () => {
  beforeEach(() => {
    process.env.MAGENTA_TEST_OPENAI_KEY = "test-key";
  });

  it("runs a ThreadCore turn end to end, including a tool call", async () => {
    const { core, client } = createThreadCore();
    core.sendMessage([{ type: "user", text: "do the task" }]);

    const stream = await client.awaitStream();
    expect(stream.instructions).toBeTruthy();
    stream.streamText("working on it");
    stream.streamToolCall(
      "call-yield-1" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "all done" },
    );
    stream.finishResponse("tool_use");

    await pollUntil(() => {
      if (core.state.mode.type === "yielded") return true;
      throw new Error(`waiting for yielded, got ${core.state.mode.type}`);
    });
    expect(core.state.mode.type).toBe("yielded");
    if (core.state.mode.type === "yielded") {
      expect(core.state.mode.response).toBe("all done");
    }
  });

  it("caches one provider instance per profile name", () => {
    const base = {
      provider: "openai",
      model: "gpt-5.4",
      fastModel: "gpt-5.4-mini",
      thinkingModel: "gpt-5.4",
      apiKeyEnvVar: "MAGENTA_TEST_OPENAI_KEY",
    } as const;
    const a = getProvider(noopLogger, undefined, validateInput, undefined, {
      ...base,
      name: "openai-a",
      baseUrl: "https://a.example.com/v1",
    });
    const b = getProvider(noopLogger, undefined, validateInput, undefined, {
      ...base,
      name: "openai-b",
      baseUrl: "https://b.example.com/v1",
    });
    const aAgain = getProvider(
      noopLogger,
      undefined,
      validateInput,
      undefined,
      { ...base, name: "openai-a", baseUrl: "https://a.example.com/v1" },
    );

    expect(a).toBeInstanceOf(OpenAIProvider);
    expect(a).not.toBe(b);
    expect(a).toBe(aAgain);
  });

  describe("chatgpt auth", () => {
    const stubAuth = (): OpenAIAuth & {
      refreshCalls: number;
    } => {
      const auth = {
        refreshCalls: 0,
        isAuthenticated: () => Promise.resolve(true),
        getCredentials: () =>
          Promise.resolve({ accessToken: "tok-1", accountId: "acct" }),
        refreshCredentials: () => {
          auth.refreshCalls++;
          return Promise.resolve({ accessToken: "tok-2", accountId: "acct" });
        },
        login: () => Promise.resolve(),
      };
      return auth;
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("refreshes and retries exactly once on a 401", async () => {
      const auth = stubAuth();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "expired" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      );

      const provider = new OpenAIProvider(
        noopLogger,
        validateInput,
        { authType: "chatgpt" },
        auth,
      );

      const request = provider.forceToolUse({
        model: "gpt-5.4",
        input: [
          {
            type: "text",
            text: "hi",
            nativeMessageIdx: PLACEHOLDER_NATIVE_MESSAGE_IDX,
          },
        ],
        spec: {
          name: "thread_title" as ToolName,
          description: "title",
          input_schema: { type: "object", properties: {} },
        } as never,
      });

      await expect(request.promise).rejects.toThrow();
      expect(auth.refreshCalls).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const [, secondInit] = fetchMock.mock.calls[1];
      const headers = (secondInit as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers.authorization).toBe("Bearer tok-2");
      expect(headers["chatgpt-account-id"]).toBe("acct");
    });

    it("rejects codex-family models with an actionable error", () => {
      const provider = new OpenAIProvider(
        noopLogger,
        validateInput,
        { authType: "chatgpt" },
        stubAuth(),
      );

      expect(() =>
        provider.createAgent({
          model: "gpt-5.1-codex",
          systemPrompt: "hi",
          tools: [],
        }),
      ).toThrow(/gpt-5\.4/);
    });
  });
});
