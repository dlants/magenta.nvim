import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "../agent.ts";
import type { ThreadId, ThreadType } from "../chat-types.ts";
import type { Logger } from "../logger.ts";
import type { OpenAIAuth } from "../openai-auth.ts";
import type { ProviderProfile } from "../provider-options.ts";
import { Thread } from "../thread.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { validateInput } from "../tools/helpers.ts";
import type { MCPToolManager } from "../tools/mcp/manager.ts";
import { pollUntil } from "../utils/async.ts";
import { MockOpenAIClient, mockResponse } from "./mock-openai-client.ts";
import { OpenAIProvider } from "./openai.ts";
import { anthropicAuthType, getProvider } from "./provider.ts";
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

function createTestAgent(): { core: Thread; client: MockOpenAIClient } {
  const client = new MockOpenAIClient();
  const provider = createProvider(client);
  const context: AgentContext = {
    logger: noopLogger,
    profile: {
      name: "openai-test",
      provider: "openai",
      model: "gpt-5.4",
    } as ProviderProfile,
    cwd: "/tmp" as AgentContext["cwd"],
    homeDir: "/home" as AgentContext["homeDir"],
    threadType: "subagent" as ThreadType,
    systemPrompt: "test system prompt" as unknown as SystemPrompt,
    systemInfo: {
      timestamp: "Mon Jan 01 2024 00:00:00 GMT+0000",
      platform: "linux",
      neovimVersion: "0.10.0",
      cwd: "/tmp" as AgentContext["cwd"],
    },
    mcpToolManager: {
      serverMap: {},
      getToolSpecs: () => [],
    } as unknown as MCPToolManager,
    threadManager: {
      getThread: () => undefined,
      getThreads: () => [],
    } as unknown as AgentContext["threadManager"],
    fileIO: {
      readFile: async () => "",
      writeFile: async () => {},
      fileExists: async () => false,
    } as unknown as AgentContext["fileIO"],
    shell: {
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    } as unknown as AgentContext["shell"],
    gitClient: {
      getState: async () => undefined,
    } as unknown as AgentContext["gitClient"],
    lspClient: {} as unknown as AgentContext["lspClient"],
    availableCapabilities: new Set(),
    environmentConfig: { type: "local" },
    maxConcurrentSubagents: 1,
    maxConcurrentFastSubagents: 8,
    getAgents: () => ({}),
    getProvider: () => provider,
  };
  return {
    core: new Thread(
      "openai-thread" as ThreadId,
      context,
      { type: "fresh" },
      {
        baseDir: path.join(os.tmpdir(), "magenta-test-archive"),
      },
    ),
    client,
  };
}

describe("OpenAI provider wiring", () => {
  beforeEach(() => {
    process.env.MAGENTA_TEST_OPENAI_KEY = "test-key";
  });

  it("runs a Agent turn end to end, including a tool call", async () => {
    const { core, client } = createTestAgent();
    // A titled thread doesn't fire the title request, which would otherwise be
    // the most recent stream when the turn's own request is awaited below.
    core.setTitle("test thread");
    void core.send([{ type: "user", text: "do the task" }]);

    const stream = await client.awaitStream();
    expect(stream.instructions).toBeTruthy();
    stream.streamText("working on it");
    stream.streamToolCall(
      "call-yield-1" as ToolRequestId,
      "yield_to_parent" as ToolName,
      { result: "all done" },
    );
    stream.finishResponse();

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

  it("does not pass openai-only authTypes through to the anthropic provider", () => {
    expect(anthropicAuthType("chatgpt")).toBeUndefined();
    expect(anthropicAuthType("max")).toBe("max");
    expect(anthropicAuthType(undefined)).toBeUndefined();
  });

  describe("chatgpt auth", () => {
    const stubAuth = (
      authenticated = true,
    ): OpenAIAuth & {
      refreshCalls: number;
      loginCalls: { onOutput?: (chunk: string) => void }[];
    } => {
      const auth = {
        refreshCalls: 0,
        loginCalls: [] as { onOutput?: (chunk: string) => void }[],
        isAuthenticated: () => Promise.resolve(authenticated),
        getCredentials: () =>
          Promise.resolve({ accessToken: "tok-1", accountId: "acct" }),
        refreshCredentials: () => {
          auth.refreshCalls++;
          return Promise.resolve({ accessToken: "tok-2", accountId: "acct" });
        },
        login: (options?: {
          onOutput?: (chunk: string) => void;
          signal?: AbortSignal | undefined;
        }) => {
          auth.loginCalls.push(options ?? {});
          options?.onOutput?.("open https://auth.example");
          return Promise.resolve();
        },
      };
      return auth;
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /** forceToolUse streams, so a canned success must be an SSE body whose
     * terminal event carries the completed response. */
    const sseToolResponse = () => {
      const event = {
        type: "response.completed",
        sequence_number: 0,
        response: mockResponse([
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "thread_title",
            arguments: JSON.stringify({ title: "hi" }),
            status: "completed",
          },
        ]),
      };
      return new Response(`data: ${JSON.stringify(event)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const titleRequest = (provider: OpenAIProvider) =>
      provider.forceToolUse({
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

    it("refreshes and retries exactly once on a 401", async () => {
      const auth = stubAuth();
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "expired" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      );

      const provider = new OpenAIProvider(noopLogger, validateInput, {
        authType: "chatgpt",
        auth,
      });

      const request = titleRequest(provider);

      await expect(request.promise).rejects.toThrow();
      expect(auth.refreshCalls).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const [, secondInit] = fetchMock.mock.calls[1];
      const headers = new Headers((secondInit as RequestInit).headers);
      expect(headers.get("authorization")).toBe("Bearer tok-2");
      expect(headers.get("chatgpt-account-id")).toBe("acct");
    });

    it("sends credentials on the first request and does not refresh on success", async () => {
      const auth = stubAuth();
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(sseToolResponse());
      const provider = new OpenAIProvider(noopLogger, validateInput, {
        authType: "chatgpt",
        auth,
      });

      await titleRequest(provider).promise;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(auth.refreshCalls).toBe(0);
      const [, init] = fetchMock.mock.calls[0];
      const headers = new Headers((init as RequestInit).headers);
      expect(headers.get("authorization")).toBe("Bearer tok-1");
      expect(headers.get("chatgpt-account-id")).toBe("acct");
    });

    it("runs codex login through the auth UI when not authenticated", async () => {
      const auth = stubAuth(false);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(sseToolResponse());
      const progress: string[] = [];
      const authUI = {
        showOAuthFlow: () => Promise.resolve(""),
        showError: () => {},
        showLoginProgress: (chunk: string) => progress.push(chunk),
      };
      const provider = new OpenAIProvider(noopLogger, validateInput, {
        authType: "chatgpt",
        auth,
        authUI,
      });

      await titleRequest(provider).promise;

      expect(auth.loginCalls.length).toBe(1);
      expect(progress).toEqual(["open https://auth.example"]);
    });

    it("throws an actionable error when not authenticated and there is no auth UI", async () => {
      const auth = stubAuth(false);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
      const provider = new OpenAIProvider(noopLogger, validateInput, {
        authType: "chatgpt",
        auth,
      });

      // The SDK wraps a fetch-layer throw in an APIConnectionError, so the
      // actionable message only survives on the cause.
      const error = await titleRequest(provider).promise.then(
        () => undefined,
        (e: Error) => e,
      );
      expect((error?.cause as Error | undefined)?.message).toMatch(
        /codex login/,
      );
      expect(auth.loginCalls.length).toBe(0);
    });

    it("rejects codex-family models with an actionable error", () => {
      const provider = new OpenAIProvider(noopLogger, validateInput, {
        authType: "chatgpt",
        auth: stubAuth(),
      });

      expect(() =>
        provider.createAgent({
          model: "gpt-5.1-codex",
          systemPrompt: "hi",
          tools: [],
          executeTools: () =>
            Promise.resolve({ type: "continue", results: new Map() }),
          onUpdate: () => {},
        }),
      ).toThrow(/gpt-5\.4/);
    });
  });
});
