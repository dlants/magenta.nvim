import { expect, it } from "vitest";
import type { ProviderToolResult } from "../providers/provider-types.ts";
import { type Harness, withHarness } from "../test/harness.ts";
import type { Thread } from "../thread.ts";
import type { ToolName, ToolRequestId } from "../tool-types.ts";
import { Defer, pollUntil } from "../utils/async.ts";
import { mockServers } from "./mcp/mock-server.ts";
import type { ServerName } from "./mcp/types.ts";

/** Respond to the pending turn with one tool call, then end the next turn. */
async function runTool(
  h: Harness,
  thread: Thread,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ProviderToolResult["result"]> {
  const id = `${toolName}-call` as ToolRequestId;
  const done = h.send(thread, `use ${toolName}`);
  const stream = await h.nextStream();
  stream.respond({
    stopReason: "tool_use",
    text: "ok",
    toolRequests: [
      { status: "ok", value: { id, toolName: toolName as ToolName, input } },
    ],
  });
  const followup = await h.nextStream();
  followup.respond({ stopReason: "end_turn", text: "done", toolRequests: [] });
  await done;
  const info = thread.completedTools.get(id);
  if (!info) throw new Error(`no result for ${id}`);
  return info.result.result;
}

function okText(result: ProviderToolResult["result"]): string {
  if (result.status !== "ok") throw new Error(result.error);
  const [block] = result.value;
  if (block?.type !== "text") throw new Error("expected a text block");
  return block.text;
}

const lua = (execLua: (code: string) => Promise<unknown>) => ({
  luaExecutor: { execLua },
});

it("nvim_lua evaluates code and returns the result", async () => {
  await withHarness(
    lua(async () => 3),
    async (h) => {
      const { thread } = await h.createRoot();
      const result = await runTool(h, thread, "nvim_lua", {
        code: "return 1 + 2",
      });
      expect(okText(result)).toBe("3");
    },
  );
});

it("nvim_lua handles a nil return value", async () => {
  await withHarness(
    lua(async () => null),
    async (h) => {
      const { thread } = await h.createRoot();
      const result = await runTool(h, thread, "nvim_lua", {
        code: "local x = 1",
      });
      expect(okText(result)).toBe("Executed successfully, no return value.");
    },
  );
});

it("nvim_lua surfaces Lua errors as error results", async () => {
  const execLua = () => Promise.reject(new Error("lua: boom"));
  await withHarness(lua(execLua), async (h) => {
    const { thread } = await h.createRoot();
    const result = await runTool(h, thread, "nvim_lua", {
      code: "error('boom')",
    });
    expect(result.status).toBe("error");
    expect(result.status === "error" && result.error).toContain("boom");
  });
});

it("sets thread title after user message", async () => {
  await withHarness({}, async (h) => {
    const requests: {
      model: string;
      input: unknown[];
      defer: Defer<unknown>;
    }[] = [];
    h.host.provider.forceToolUse = ({ model, input }) => {
      const defer = new Defer<unknown>();
      requests.push({ model, input, defer });
      return {
        abort: () => {},
        aborted: false,
        promise: defer.promise as never,
      };
    };
    const { thread } = await h.createRoot();
    const userMessage = "Tell me about the solar system";
    const done = h.send(thread, userMessage);
    const request = await pollUntil(() => {
      const r = requests[0];
      if (!r) throw new Error("waiting for title request");
      return r;
    });
    expect(request.model).toBe(h.host.profile.fastModel);
    expect(request.input).toMatchObject([
      { type: "text", text: expect.stringContaining(userMessage) },
    ]);
    const title = "Exploring the Solar System";
    request.defer.resolve({
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 },
      toolRequest: {
        status: "ok",
        value: {
          id: "id" as ToolRequestId,
          toolName: "thread_title" as ToolName,
          input: { title },
        },
      },
    });
    await pollUntil(() => {
      if (thread.title !== title) throw new Error("waiting for title");
    });
    const stream = await h.nextStream();
    stream.respond({
      stopReason: "end_turn",
      text: "The Sun.",
      toolRequests: [],
    });
    await done;
    expect(thread.title).toBe(title);
  });
});

const serverName = "test-server" as ServerName;
const mcp = (tool: {
  name: string;
  description: string;
  inputSchema: Record<string, "string" | "boolean">;
}) => ({
  mcpServers: { [serverName]: { type: "mock" as const, tools: [tool] } },
});

async function toolStub(name: string) {
  const server = await pollUntil(() => {
    const s = mockServers[serverName];
    if (!s) throw new Error("waiting for mock server");
    return s;
  });
  return server.awaitToolStub(name);
}

/** Wait until the manager has connected so the tool spec is offered. */
async function mcpReady(h: Harness) {
  await pollUntil(() => {
    if (!h.host.mcp.getToolSpecs().length) throw new Error("mcp not ready");
  });
}

it("should call mock tool through chat agent", async () => {
  const tool = {
    name: "echo_test",
    description: "Echoes back the input text",
    inputSchema: { text: "string" as const },
  };
  await withHarness(mcp(tool), async (h) => {
    const stub = await toolStub("echo_test");
    await mcpReady(h);
    const { thread } = await h.createRoot();
    const pending = runTool(h, thread, "mcp_test-server_echo_test", {
      text: "Hello World",
    });
    const call = await stub.awaitCall();
    expect(call.args).toEqual({ text: "Hello World" });
    stub.respondWith("Echo: Hello World");
    const result = await pending;
    expect(result.status).toBe("ok");
    expect(JSON.stringify(result)).toContain("Echo: Hello World");
  });
});

it("should handle tool errors gracefully", async () => {
  const tool = {
    name: "error_test",
    description: "A tool that can simulate errors",
    inputSchema: { shouldError: "boolean" as const },
  };
  await withHarness(mcp(tool), async (h) => {
    const stub = await toolStub("error_test");
    await mcpReady(h);
    const { thread } = await h.createRoot();
    const pending = runTool(h, thread, "mcp_test-server_error_test", {
      shouldError: true,
    });
    const call = await stub.awaitCall();
    expect(call.args).toEqual({ shouldError: true });
    stub.respondWithError("Simulated tool error");
    const result = await pending;
    expect(result.status).toBe("error");
    expect(JSON.stringify(result)).toContain("Simulated tool error");
  });
});

it("should handle tools with no input schema", async () => {
  const tool = {
    name: "simple_test",
    description: "A tool that takes no input",
    inputSchema: {},
  };
  await withHarness(mcp(tool), async (h) => {
    const stub = await toolStub("simple_test");
    await mcpReady(h);
    const { thread } = await h.createRoot();
    const pending = runTool(h, thread, "mcp_test-server_simple_test", {});
    await stub.awaitCall();
    stub.respondWith("Simple tool executed successfully");
    const result = await pending;
    expect(result.status).toBe("ok");
  });
});
