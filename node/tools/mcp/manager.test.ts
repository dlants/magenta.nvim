import { it, expect } from "vitest";
import { withDriver, assertHasMcpServer } from "../../test/preamble.ts";
import type { ServerName, ToolRequestId, ToolName } from "@magenta/core";

const serverName = "test-server" as ServerName;

it("should call mock tool through chat agent", async () => {
  const testTool = {
    name: "echo_test",
    description: "Echoes back the input text",
    inputSchema: {
      text: "string" as const,
    },
  };

  await withDriver(
    {
      options: {
        mcpServers: {
          [serverName]: {
            type: "mock",
            tools: [testTool],
          },
        },
      },
    },
    async (driver) => {
      await driver.showSidebar();

      // Get the mock server to set up tool response
      const mockServer = await assertHasMcpServer(serverName);

      const toolStub = await mockServer.awaitToolStub("echo_test");
      expect(toolStub).toBeDefined();

      await driver.inputMagentaText(
        "Use echo_test tool with text 'Hello World'",
      );
      await driver.send();

      const request =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Use echo_test tool",
        );

      // Respond with a tool call
      request.respond({
        stopReason: "tool_use",
        text: "I'll use the echo_test tool for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-echo-call" as ToolRequestId,
              toolName: "mcp_test-server_echo_test" as ToolName,
              input: {
                text: "Hello World",
              },
            },
          },
        ],
      });

      // Wait for the tool call and respond
      const toolCall = await toolStub.awaitCall();
      expect(toolCall.args).toEqual({ text: "Hello World" });

      toolStub.respondWith("Echo: Hello World");

      // Verify the tool completion appears in the chat
      await driver.assertDisplayBufferContains(
        "🔨✅ MCP tool `mcp_test-server_echo_test`",
      );

      // Continue the conversation to show the tool result was processed
      const followupRequest =
        await driver.mockAnthropic.awaitPendingStreamWithText(
          "Echo: Hello World",
        );
      followupRequest.streamText("Great! The echo tool worked perfectly.");
      followupRequest.finishResponse("end_turn");

      await driver.assertDisplayBufferContains(
        "Great! The echo tool worked perfectly.",
      );
    },
  );
});

it("should handle tool errors gracefully", async () => {
  const errorTool = {
    name: "error_test",
    description: "A tool that can simulate errors",
    inputSchema: {
      shouldError: "boolean" as const,
    },
  };

  await withDriver(
    {
      options: {
        mcpServers: {
          [serverName]: {
            type: "mock",
            tools: [errorTool],
          },
        },
      },
    },
    async (driver) => {
      await driver.waitForChatReady();
      await driver.showSidebar();

      const mockServer = await assertHasMcpServer(serverName);
      const toolStub = await mockServer.awaitToolStub("error_test");
      expect(toolStub).toBeDefined();

      await driver.inputMagentaText(
        "Use error_test tool with shouldError=true",
      );
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Use error_test tool",
      );

      request.respond({
        stopReason: "tool_use",
        text: "I'll test the error handling.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-error-call" as ToolRequestId,
              toolName: "mcp_test-server_error_test" as ToolName,
              input: {
                shouldError: true,
              },
            },
          },
        ],
      });

      // Wait for the tool call and respond with an error
      const toolCall = await toolStub.awaitCall();
      expect(toolCall.args).toEqual({ shouldError: true });

      toolStub.respondWithError("Simulated tool error");

      // Verify the error appears in the chat
      await driver.assertDisplayBufferContains(
        "🔨❌ MCP tool `mcp_test-server_error_test`",
      );

      // Continue conversation to show error was handled
      await driver.mockAnthropic.awaitPendingStreamWithText(
        "Error: Simulated tool error",
      );
    },
  );
});

it("should handle tools with no input schema", async () => {
  const noInputTool = {
    name: "simple_test",
    description: "A tool that takes no input",
    inputSchema: {},
  };

  await withDriver(
    {
      options: {
        mcpServers: {
          [serverName]: {
            type: "mock",
            tools: [noInputTool],
          },
        },
      },
    },
    async (driver) => {
      await driver.showSidebar();

      const mockServer = await assertHasMcpServer(serverName);
      const toolStub = await mockServer.awaitToolStub("simple_test");
      expect(toolStub).toBeDefined();

      await driver.inputMagentaText("Use the simple_test tool");
      await driver.send();

      const request = await driver.mockAnthropic.awaitPendingStreamWithText(
        "Use the simple_test tool",
      );

      request.respond({
        stopReason: "tool_use",
        text: "I'll use the simple test tool.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "test-simple-call" as ToolRequestId,
              toolName: "mcp_test-server_simple_test" as ToolName,
              input: {},
            },
          },
        ],
      });

      await toolStub.awaitCall();
      toolStub.respondWith("Simple tool executed successfully");

      // Verify the response appears
      await driver.assertDisplayBufferContains(
        "🔨✅ MCP tool `mcp_test-server_simple_test`",
      );
    },
  );
});
