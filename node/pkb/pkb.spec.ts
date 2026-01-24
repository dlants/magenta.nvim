import { it, expect } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { withDriver } from "../test/preamble.ts";
import { respondToEmbedRequest } from "./embedding/mock.ts";
import { pollUntil } from "../utils/async.ts";
import type { NvimDriver } from "../test/driver.ts";

async function respondToAllContextRequests(driver: NvimDriver) {
  let count = 0;
  while (true) {
    const pendingRequest = driver.mockAnthropic.textRequests.find(
      (r) => !r.defer.resolved,
    );
    if (!pendingRequest) break;
    pendingRequest.defer.resolve({
      text: `Context for chunk ${count + 1}`,
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    count++;
    await driver.wait(10);
  }
  return count;
}

async function awaitEmbedRequestWithContextResponses(driver: NvimDriver) {
  return pollUntil(async () => {
    await respondToAllContextRequests(driver);
    const embedReq = driver.mockEmbed!.requests.find((r) => !r.defer.resolved);
    if (!embedReq) {
      throw new Error("waiting for embedChunks call");
    }
    return embedReq;
  });
}

it("should search and return relevant chunks", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const pkbDir = path.join(tmpDir, "pkb");
        await fs.mkdir(pkbDir);
        await fs.writeFile(
          path.join(pkbDir, "doc1.md"),
          "# Apples\n\nApples are red fruits that grow on trees.",
        );
        await fs.writeFile(
          path.join(pkbDir, "doc2.md"),
          "# Oranges\n\nOranges are orange colored citrus fruits.",
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

      // Trigger reindex to index both files
      const reindexPromise = driver.magenta.pkbManager!.reindex();

      // First file embedding
      const embedReq1 = await awaitEmbedRequestWithContextResponses(driver);
      const chunks1 = embedReq1.input as string[];
      respondToEmbedRequest(
        embedReq1,
        chunks1.map(() => [0.9, 0.1, 0.1]), // apple-like embedding
      );

      // Second file embedding
      const embedReq2 = await awaitEmbedRequestWithContextResponses(driver);
      const chunks2 = embedReq2.input as string[];
      respondToEmbedRequest(
        embedReq2,
        chunks2.map(() => [0.1, 0.9, 0.1]), // orange-like embedding
      );

      await reindexPromise;

      // Search
      const searchPromise = driver.magenta.pkb!.search("apple fruit", 5);
      const queryReq = await driver.mockEmbed!.awaitPendingRequest();
      respondToEmbedRequest(queryReq, [0.9, 0.1, 0.1]); // apple-like query
      const results = await searchPromise;

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].score).toBeGreaterThan(0);
      expect(results[0].file).toBeDefined();
      expect(results[0].chunk.text).toBeDefined();
    },
  );
});

it("should return empty results for empty PKB", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const pkbDir = path.join(tmpDir, "pkb");
        await fs.mkdir(pkbDir);
        // No files in pkb directory
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

      // Search with no indexed files
      const searchPromise = driver.magenta.pkb!.search("anything", 5);
      const queryReq = await driver.mockEmbed!.awaitPendingRequest();
      respondToEmbedRequest(queryReq, [0.5, 0.5, 0.5]);
      const results = await searchPromise;

      expect(results).toHaveLength(0);
    },
  );
});
