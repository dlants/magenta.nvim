import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolName, ToolRequestId } from "@magenta/core";
import { describe, expect, it } from "vitest";
import { withDriver } from "../test/preamble.ts";

const MINIMAL_DOCKERFILE = `\
FROM node:24-bookworm-slim
WORKDIR /workspace
COPY . .
CMD ["tail", "-f", "/dev/null"]
`;

describe("docker subagent file sync", () => {
  it(
    "files edited and created in docker container are synced back to host on yield",
    async () => {
      await withDriver(
        {
          setupFiles: async (tmpDir: string) => {
            // Create a file that the subagent will modify
            await fs.promises.writeFile(
              path.join(tmpDir, "test-file.txt"),
              "original",
            );

            // Create a minimal Dockerfile
            await fs.promises.writeFile(
              path.join(tmpDir, "Dockerfile"),
              MINIMAL_DOCKERFILE,
            );
          },
        },
        async (driver, dirs) => {
          await driver.showSidebar();

          await driver.inputMagentaText(
            "Spawn a docker subagent to edit files.",
          );
          await driver.send();

          // Parent thread gets the user message and responds with spawn_subagents
          const request1 =
            await driver.mockAnthropic.awaitPendingStreamWithText(
              "Spawn a docker subagent",
            );
          request1.respond({
            stopReason: "tool_use",
            text: "I'll spawn a docker subagent.",
            toolRequests: [
              {
                status: "ok",
                value: {
                  id: "test-docker-spawn" as ToolRequestId,
                  toolName: "spawn_subagents" as ToolName,
                  input: {
                    agents: [
                      {
                        prompt:
                          "Edit test-file.txt and create new-file.txt, then yield.",
                        environment: "docker_unsupervised",
                        dockerfile: "Dockerfile",
                        workspacePath: "/workspace",
                      },
                    ],
                  },
                },
              },
            ],
          });

          // The docker subagent gets its prompt and responds with bash_command
          // Needs a long timeout because Docker image build + container start happens first
          const request2 =
            await driver.mockAnthropic.awaitPendingStreamWithText(
              "Edit test-file.txt",
              { timeout: 90_000 },
            );
          request2.respond({
            stopReason: "tool_use",
            text: "I'll edit the files now.",
            toolRequests: [
              {
                status: "ok",
                value: {
                  id: "test-docker-bash" as ToolRequestId,
                  toolName: "bash_command" as ToolName,
                  input: {
                    command:
                      'echo "modified" > /workspace/test-file.txt && echo "new content" > /workspace/new-file.txt',
                  },
                },
              },
            ],
          });

          // After bash_command completes, subagent yields
          const request3 =
            await driver.mockAnthropic.awaitPendingStreamWithText(
              "exit code 0",
              { timeout: 10_000 },
            );
          request3.respond({
            stopReason: "tool_use",
            text: "Files updated. Yielding back to parent.",
            toolRequests: [
              {
                status: "ok",
                value: {
                  id: "test-docker-yield" as ToolRequestId,
                  toolName: "yield_to_parent" as ToolName,
                  input: {
                    result: "Files edited successfully",
                  },
                },
              },
            ],
          });

          // Wait for the parent to get the spawn_subagents result
          // Teardown (docker cp + rsync) may take a few seconds
          await driver.assertDisplayBufferContains("✅ 1 agent", 0, 15_000);

          // Verify files were synced back to the host
          const testFileContent = await fs.promises.readFile(
            path.join(dirs.tmpDir, "test-file.txt"),
            "utf-8",
          );
          expect(testFileContent.trim()).toBe("modified");

          const newFileContent = await fs.promises.readFile(
            path.join(dirs.tmpDir, "new-file.txt"),
            "utf-8",
          );
          expect(newFileContent.trim()).toBe("new content");
        },
      );
    },
    { timeout: 120_000 },
  );

  it(
    "docker sync does not overwrite .magenta/options.json on host",
    async () => {
      await withDriver(
        {
          setupFiles: async (tmpDir: string) => {
            // Create .magenta/options.json so we can verify it's not overwritten
            const magentaDir = path.join(tmpDir, ".magenta");
            await fs.promises.mkdir(magentaDir, { recursive: true });
            await fs.promises.writeFile(
              path.join(magentaDir, "options.json"),
              JSON.stringify({ sandbox: {} }),
            );

            await fs.promises.writeFile(
              path.join(tmpDir, "Dockerfile"),
              MINIMAL_DOCKERFILE,
            );
          },
        },
        async (driver, dirs) => {
          const originalOptions = await fs.promises.readFile(
            path.join(dirs.tmpDir, ".magenta", "options.json"),
            "utf-8",
          );

          await driver.showSidebar();
          await driver.inputMagentaText(
            "Spawn a docker subagent to tamper with options.",
          );
          await driver.send();

          const request1 =
            await driver.mockAnthropic.awaitPendingStreamWithText(
              "Spawn a docker subagent to tamper",
            );
          request1.respond({
            stopReason: "tool_use",
            text: "Spawning docker subagent.",
            toolRequests: [
              {
                status: "ok",
                value: {
                  id: "test-options-spawn" as ToolRequestId,
                  toolName: "spawn_subagents" as ToolName,
                  input: {
                    agents: [
                      {
                        prompt: "Tamper with options.json then yield.",
                        environment: "docker_unsupervised",
                        dockerfile: "Dockerfile",
                        workspacePath: "/workspace",
                      },
                    ],
                  },
                },
              },
            ],
          });

          const request2 =
            await driver.mockAnthropic.awaitPendingStreamWithText(
              "Tamper with options.json",
              { timeout: 90_000 },
            );
          request2.respond({
            stopReason: "tool_use",
            text: "Tampering with options.",
            toolRequests: [
              {
                status: "ok",
                value: {
                  id: "test-options-bash" as ToolRequestId,
                  toolName: "bash_command" as ToolName,
                  input: {
                    command:
                      'echo \'{"container":{"dockerfile":"Dockerfile","workspacePath":"/workspace"},"sandbox":{"filesystem":{"allowWrite":["/"]},"denyWrite":[]}}\' > /workspace/.magenta/options.json',
                  },
                },
              },
            ],
          });

          const request3 =
            await driver.mockAnthropic.awaitPendingStreamWithText(
              "exit code 0",
              { timeout: 10_000 },
            );
          request3.respond({
            stopReason: "tool_use",
            text: "Done. Yielding.",
            toolRequests: [
              {
                status: "ok",
                value: {
                  id: "test-options-yield" as ToolRequestId,
                  toolName: "yield_to_parent" as ToolName,
                  input: {
                    result: "Tampered with options",
                  },
                },
              },
            ],
          });

          await driver.assertDisplayBufferContains("✅ 1 agent", 0, 15_000);

          // Verify .magenta/options.json was NOT overwritten
          const afterOptions = await fs.promises.readFile(
            path.join(dirs.tmpDir, ".magenta", "options.json"),
            "utf-8",
          );
          expect(afterOptions).toBe(originalOptions);
        },
      );
    },
    { timeout: 120_000 },
  );
});
