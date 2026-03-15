import type Anthropic from "@anthropic-ai/sdk";
import type { ToolName, ToolRequestId } from "@magenta/core";
import { expect, it } from "vitest";

import { type TestOptions, withDriver } from "../test/preamble.ts";

type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;

it("use_skill e2e: host thread executes skill and returns output", async () => {
  await withDriver(
    {
      options: {
        toolSkills: {
          host: [
            {
              name: "echo-skill",
              description: "Echoes input back",
              command: ["bash", "-c", 'echo "skill got: $0"'],
            },
          ],
        },
      } as unknown as TestOptions,
    },
    async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("Please use my echo skill");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-use-skill" as ToolRequestId;

      // Verify use_skill is available in tool specs
      const tools = stream.params.tools ?? [];
      const toolNames = tools.map((s) => s.name);
      expect(toolNames).toContain("use_skill");

      // Respond with a use_skill tool request
      stream.respond({
        stopReason: "tool_use",
        text: "Let me use the echo skill for you.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "use_skill" as ToolName,
              input: {
                skill: "echo-skill",
                input: { message: "hello world" },
              },
            },
          },
        ],
      });

      // Wait for the next stream which will contain the tool result
      const stream2 = await driver.mockAnthropic.awaitPendingStream();

      // Find the user message containing the tool result
      let toolResult: ToolResultBlockParam | undefined;
      for (const msg of stream2.messages) {
        if (msg.role === "user" && Array.isArray(msg.content)) {
          const content = msg.content as ContentBlockParam[];
          const found = content.find(
            (block: ContentBlockParam) => block.type === "tool_result",
          );
          if (found) {
            toolResult = found as ToolResultBlockParam;
          }
        }
      }

      if (!toolResult) throw new Error("Expected tool result in messages");
      expect(toolResult.is_error).toBeFalsy();

      const contentStr =
        typeof toolResult.content === "string"
          ? toolResult.content
          : JSON.stringify(toolResult.content);
      expect(contentStr).toContain("skill got:");

      stream2.respond({
        stopReason: "end_turn",
        text: "The echo skill returned the expected output.",
        toolRequests: [],
      });

      await driver.assertDisplayBufferContains(
        "The echo skill returned the expected output.",
      );
    },
  );
});

it("use_skill e2e: returns error for unknown skill", async () => {
  await withDriver(
    {
      options: {
        toolSkills: {
          host: [
            {
              name: "real-skill",
              description: "A real skill",
              command: ["echo"],
            },
          ],
        },
      } as unknown as TestOptions,
    },
    async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("Use a nonexistent skill");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      const toolRequestId = "test-unknown-skill" as ToolRequestId;

      stream.respond({
        stopReason: "tool_use",
        text: "Let me try that skill.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: toolRequestId,
              toolName: "use_skill" as ToolName,
              input: { skill: "nonexistent-skill" },
            },
          },
        ],
      });

      const stream2 = await driver.mockAnthropic.awaitPendingStream();

      let toolResult: ToolResultBlockParam | undefined;
      for (const msg of stream2.messages) {
        if (msg.role === "user" && Array.isArray(msg.content)) {
          const content = msg.content as ContentBlockParam[];
          const found = content.find(
            (block: ContentBlockParam) => block.type === "tool_result",
          );
          if (found) {
            toolResult = found as ToolResultBlockParam;
          }
        }
      }

      if (!toolResult) throw new Error("Expected tool result in messages");
      expect(toolResult.is_error).toBe(true);

      const errorStr =
        typeof toolResult.content === "string"
          ? toolResult.content
          : JSON.stringify(toolResult.content);
      expect(errorStr).toContain("Unknown skill");
      expect(errorStr).toContain("nonexistent-skill");

      stream2.respond({
        stopReason: "end_turn",
        text: "Sorry, that skill doesn't exist.",
        toolRequests: [],
      });
    },
  );
});

it("use_skill: docker thread does not see host skills", async () => {
  await withDriver(
    {
      options: {
        toolSkills: {
          host: [
            {
              name: "host-only",
              description: "Host only skill",
              command: ["echo", "host"],
            },
          ],
          docker: [
            {
              name: "docker-only",
              description: "Docker only skill",
              command: ["echo", "docker"],
            },
          ],
        },
      } as unknown as TestOptions,
    },
    async (driver) => {
      await driver.showSidebar();
      await driver.inputMagentaText("Test host skill isolation");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();

      // In a host thread, only host skills should be available
      const tools = stream.params.tools ?? [];
      const useSkillSpec = tools.find((s) => s.name === "use_skill");
      expect(useSkillSpec).toBeDefined();
      if (!useSkillSpec || !("description" in useSkillSpec))
        throw new Error("Expected use_skill with description");
      expect(useSkillSpec.description).toContain("host-only");
      expect(useSkillSpec.description).not.toContain("docker-only");

      stream.respond({
        stopReason: "end_turn",
        text: "Done.",
        toolRequests: [],
      });
    },
  );
});
