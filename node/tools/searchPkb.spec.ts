import { describe, it, expect } from "vitest";
import { withDriver, pollForToolResult } from "../test/preamble.ts";
import * as fs from "fs/promises";
import * as path from "path";
import { respondToEmbedRequest } from "../pkb/embedding/mock.ts";
import type { ToolRequestId, ToolName } from "./types.ts";

describe("searchPkb tool", () => {
  it("should search PKB and return relevant chunks", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          const pkbDir = path.join(tmpDir, "pkb");
          await fs.mkdir(pkbDir);
          await fs.writeFile(
            path.join(pkbDir, "notes.md"),
            `# Project Documentation

## Architecture Overview
The system uses a microservices architecture with REST APIs for communication between services.
Each service is independently deployable and scalable, following the principles of domain-driven design.
The architecture enables teams to work autonomously on different parts of the system.

### Service Communication
Services communicate via REST APIs and message queues. We use RabbitMQ for async messaging.
This pattern helps decouple services and improves system resilience.

### Deployment
All services are containerized using Docker and orchestrated with Kubernetes.
We use Helm charts for deployment configuration and ArgoCD for GitOps-style continuous delivery.

${"Lorem ipsum dolor sit amet. ".repeat(80)}

## Database Design
We use PostgreSQL for persistent storage of relational data.
The database follows a multi-tenant architecture with row-level security.

### Schema Design
Each service owns its data and exposes it through well-defined APIs.
We avoid shared databases to maintain service independence.

### Data Migration
Database migrations are handled using Flyway, with version-controlled SQL scripts.
All migrations are tested in staging before production deployment.

${"Consectetur adipiscing elit. ".repeat(80)}

## Security Considerations
Authentication is handled via OAuth 2.0 with JWT tokens.
All API endpoints require authentication except for health checks.

### Authorization
Role-based access control (RBAC) is implemented at the service level.
Permissions are validated on each request using a centralized authorization service.

### Audit Logging
All sensitive operations are logged for compliance and debugging purposes.
Logs are shipped to a centralized ELK stack for analysis.`,
          );
        },
        options: {
          pkb: {
            path: "./pkb",
            embeddingModel: { provider: "mock" },
          },
        },
      },
      async (driver) => {
        expect(driver.mockEmbed).toBeDefined();

        // PKBManager starts immediately and calls updateEmbeddings
        // which will call embedChunks on our mock
        const embedRequest = await driver.mockEmbed!.awaitPendingRequest(
          "waiting for initial embedChunks call",
        );
        expect(embedRequest.type).toBe("chunks");

        // Respond with embeddings for the chunks
        // Create embeddings that will produce distinct similarity scores:
        // - Chunk 0 (architecture): [1, 0, 0] - closest to query
        // - Chunk 1 (lorem ipsum): [0.5, 0.5, 0] - medium similarity
        // - Chunk 2 (database): [0.3, 0.3, 0.3] - lower similarity
        // - Chunk 3 (more filler): [0, 0.5, 0.5] - even lower
        // - Chunk 4 (security): [0, 0, 1] - orthogonal to query
        const chunks = embedRequest.input as string[];
        const chunkEmbeddings = [
          [1, 0, 0],
          [0.5, 0.5, 0],
          [0.3, 0.3, 0.3],
          [0, 0.5, 0.5],
          [0, 0, 1],
        ];
        const embeddings = chunks.map(
          (_, i) => chunkEmbeddings[i] || [0.1, 0.1, 0.1],
        );
        respondToEmbedRequest(embedRequest, embeddings);

        // Now show sidebar and send a message
        await driver.showSidebar();
        await driver.inputMagentaText("Search for architecture info");
        await driver.send();

        // Wait for the stream and respond with search_pkb tool use
        const stream = await driver.mockAnthropic.awaitPendingStream();
        stream.respond({
          stopReason: "tool_use",
          text: "I'll search the PKB for architecture information.",
          toolRequests: [
            {
              status: "ok",
              value: {
                id: "search_1" as ToolRequestId,
                toolName: "search_pkb" as ToolName,
                input: { query: "architecture", topK: 5 },
              },
            },
          ],
        });

        // The search_pkb tool will call embedQuery on the mock
        const queryRequest = await driver.mockEmbed!.awaitPendingRequest(
          "waiting for embedQuery call",
        );
        expect(queryRequest.type).toBe("query");
        expect(queryRequest.input).toBe("architecture");

        // Query embedding similar to architecture chunk
        respondToEmbedRequest(queryRequest, [1, 0, 0]);

        // Wait for tool result to be sent back to the model
        const toolResult = await pollForToolResult(
          driver,
          "search_1" as ToolRequestId,
        );

        expect(toolResult.result).toMatchSnapshot();
      },
    );
  });

  it("should re-embed file when content changes", async () => {
    let tmpDirPath: string;

    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          tmpDirPath = tmpDir;
          const pkbDir = path.join(tmpDir, "pkb");
          await fs.mkdir(pkbDir);
          await fs.writeFile(
            path.join(pkbDir, "notes.md"),
            "# Original Content\nThis is the initial content.",
          );
        },
        options: {
          pkb: {
            path: "./pkb",
            embeddingModel: { provider: "mock" },
            updateIntervalMs: 100,
          },
        },
      },
      async (driver) => {
        expect(driver.mockEmbed).toBeDefined();

        // Wait for initial embedding request
        const initialRequest = await driver.mockEmbed!.awaitPendingRequest(
          "waiting for initial embedChunks call",
        );
        expect(initialRequest.type).toBe("chunks");
        const initialChunks = initialRequest.input as string[];
        expect(initialChunks[0]).toContain("Original Content");

        // Respond to initial request
        respondToEmbedRequest(
          initialRequest,
          initialChunks.map(() => [0.1, 0.2, 0.3]),
        );

        // Modify the file
        await fs.writeFile(
          path.join(tmpDirPath!, "pkb", "notes.md"),
          "# Updated Content\nThis content has been modified.",
        );

        // Wait for re-embedding request (triggered by the interval)
        const updateRequest = await driver.mockEmbed!.awaitPendingRequest(
          "waiting for re-embed after file change",
        );
        expect(updateRequest.type).toBe("chunks");
        const updatedChunks = updateRequest.input as string[];
        expect(updatedChunks[0]).toContain("Updated Content");

        // Respond to update request
        respondToEmbedRequest(
          updateRequest,
          updatedChunks.map(() => [0.4, 0.5, 0.6]),
        );
      },
    );
  });
});

it("shows summary with result count, preview with files, and can toggle to detail", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const pkbDir = path.join(tmpDir, "pkb");
        await fs.mkdir(pkbDir);
        await fs.writeFile(
          path.join(pkbDir, "notes.md"),
          `# Architecture Overview
The system uses microservices.

## Service Communication
Services communicate via REST APIs.`,
        );
      },
      options: {
        pkb: {
          path: "./pkb",
          embeddingModel: { provider: "mock" },
        },
      },
    },
    async (driver) => {
      const embedRequest = await driver.mockEmbed!.awaitPendingRequest(
        "waiting for initial embedChunks call",
      );
      const chunks = embedRequest.input as string[];
      respondToEmbedRequest(
        embedRequest,
        chunks.map(() => [1, 0, 0]),
      );

      await driver.showSidebar();
      await driver.inputMagentaText("Search for architecture info");
      await driver.send();

      const stream = await driver.mockAnthropic.awaitPendingStream();
      stream.respond({
        stopReason: "tool_use",
        text: "I'll search the PKB.",
        toolRequests: [
          {
            status: "ok",
            value: {
              id: "search_1" as ToolRequestId,
              toolName: "search_pkb" as ToolName,
              input: { query: "architecture", topK: 5 },
            },
          },
        ],
      });

      const queryRequest = await driver.mockEmbed!.awaitPendingRequest(
        "waiting for embedQuery call",
      );
      respondToEmbedRequest(queryRequest, [1, 0, 0]);

      // Wait for tool result to be sent back to the model
      await pollForToolResult(driver, "search_1" as ToolRequestId);

      // Check summary shows result count and file count
      await driver.assertDisplayBufferContains(
        '🔍✅ PKB search: "architecture"',
      );
      await driver.assertDisplayBufferContains("1 results in 1 files");

      // Check preview shows file with line ranges
      await driver.assertDisplayBufferContains("• notes.md: lines");

      // Toggle to show detail view
      const previewPos = await driver.assertDisplayBufferContains("• notes.md");
      await driver.triggerDisplayBufferKey(previewPos, "<CR>");

      // Detail view should show full content
      await driver.assertDisplayBufferContains('Query: "architecture"');
      await driver.assertDisplayBufferContains("## Result 1");
      await driver.assertDisplayBufferContains("File: notes.md");
    },
  );
});
