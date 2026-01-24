import { it, expect } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { withDriver } from "../test/preamble.ts";
import { respondToEmbedRequest } from "./embedding/mock.ts";
import { pollUntil } from "../utils/async.ts";
import type { NvimDriver } from "../test/driver.ts";

async function respondToContextRequests(
  driver: NvimDriver,
  contextResponses: string[],
) {
  let idx = 0;
  while (idx < contextResponses.length) {
    const pendingRequest = driver.mockAnthropic.textRequests.find(
      (r) => !r.defer.resolved,
    );
    if (!pendingRequest) {
      await driver.wait(10);
      continue;
    }
    pendingRequest.defer.resolve({
      text: contextResponses[idx],
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    idx++;
    await driver.wait(10);
  }
}

async function awaitEmbedRequest(driver: NvimDriver) {
  return pollUntil(async () => {
    const embedReq = driver.mockEmbed!.requests.find((r) => !r.defer.resolved);
    if (!embedReq) {
      throw new Error("waiting for embedChunks call");
    }
    return embedReq;
  });
}

it("should index new markdown files", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const pkbDir = path.join(tmpDir, "pkb");
        await fs.mkdir(pkbDir);
        await fs.writeFile(
          path.join(pkbDir, "test.md"),
          "# Test Document\n\nThis is test content.",
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

      // Manually trigger reindex
      const reindexPromise = driver.magenta.pkbManager!.reindex();

      // Respond to context generation request
      await respondToContextRequests(driver, ["Context for test document"]);

      // PKBManager indexes the file
      const embedRequest = await awaitEmbedRequest(driver);
      expect(embedRequest.type).toBe("chunks");
      const chunks = embedRequest.input as string[];
      expect(chunks.length).toBeGreaterThan(0);

      // Respond with embeddings
      respondToEmbedRequest(
        embedRequest,
        chunks.map(() => [0.1, 0.2, 0.3]),
      );

      await reindexPromise;

      const stats = driver.magenta.pkb!.getStats();
      expect(stats.totalFiles).toBe(1);
      expect(stats.totalChunks).toBeGreaterThan(0);

      const allChunks = driver.magenta.pkb!.getAllChunks();
      expect(allChunks).toMatchSnapshot();
    },
  );
});

it("should skip files that haven't changed on reindex", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        const pkbDir = path.join(tmpDir, "pkb");
        await fs.mkdir(pkbDir);
        await fs.writeFile(
          path.join(pkbDir, "test.md"),
          "# Test Document\n\nThis is test content.",
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

      // Initial indexing - trigger manually
      const reindexPromise = driver.magenta.pkbManager!.reindex();
      await respondToContextRequests(driver, ["Context for test"]);
      const embedRequest = await awaitEmbedRequest(driver);
      const chunks = embedRequest.input as string[];
      respondToEmbedRequest(
        embedRequest,
        chunks.map(() => [0.1, 0.2, 0.3]),
      );
      await reindexPromise;

      const initialRequestCount = driver.mockEmbed!.requests.length;

      // Trigger reindex again
      await driver.magenta.pkbManager!.reindex();

      // Should not have made any new embed requests since file hasn't changed
      expect(driver.mockEmbed!.requests.length).toBe(initialRequestCount);
    },
  );
});

it("should only re-embed changed chunks when file content changes", async () => {
  let tmpDirPath: string;

  const originalContent = `# Section One

This is the first section content.

# Section Two

This is the second section content.

# Section Three

This is the third section content.`;

  const modifiedContent = `# Section One

This is the first section content.

# Section Two

This section has been MODIFIED with new content.

# Section Three

This is the third section content.`;

  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        tmpDirPath = tmpDir;
        const pkbDir = path.join(tmpDir, "pkb");
        await fs.mkdir(pkbDir);
        await fs.writeFile(path.join(pkbDir, "test.md"), originalContent);
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

      // Initial indexing - trigger manually
      const reindexPromise1 = driver.magenta.pkbManager!.reindex();

      // Respond with unique context for each chunk
      await respondToContextRequests(driver, [
        "Section one introduces the document",
        "Section two provides secondary content",
        "Section three concludes the document",
      ]);

      const embedRequest = await awaitEmbedRequest(driver);
      const initialChunks = embedRequest.input as string[];
      // Should have 3 chunks (one per section)
      expect(initialChunks.length).toBe(3);
      expect(initialChunks.some((c) => c.includes("first section"))).toBe(true);
      expect(initialChunks.some((c) => c.includes("second section"))).toBe(
        true,
      );
      expect(initialChunks.some((c) => c.includes("third section"))).toBe(true);
      respondToEmbedRequest(
        embedRequest,
        initialChunks.map((_, i) => [0.1 * (i + 1), 0.2 * (i + 1), 0.3]),
      );
      await reindexPromise1;

      const statsAfterInitial = driver.magenta.pkb!.getStats();
      expect(statsAfterInitial.totalChunks).toBe(3);

      const chunksAfterInitial = driver.magenta.pkb!.getAllChunks();
      expect(chunksAfterInitial).toMatchSnapshot("after initial indexing");

      // Modify only section two
      await fs.writeFile(
        path.join(tmpDirPath!, "pkb", "test.md"),
        modifiedContent,
      );

      // Trigger reindex again manually
      const reindexPromise2 = driver.magenta.pkbManager!.reindex();

      // Only section two needs new context
      await respondToContextRequests(driver, [
        "Section two now contains modified content",
      ]);

      const updateRequest = await awaitEmbedRequest(driver);
      const updatedChunks = updateRequest.input as string[];

      // Should only embed 1 new chunk (the modified section)
      expect(updatedChunks.length).toBe(1);
      expect(updatedChunks[0]).toContain("MODIFIED");

      respondToEmbedRequest(updateRequest, [[0.4, 0.5, 0.6]]);
      await reindexPromise2;

      // Total chunks should still be 3 (2 reused + 1 new, old one deleted)
      const statsAfterUpdate = driver.magenta.pkb!.getStats();
      expect(statsAfterUpdate.totalChunks).toBe(3);

      const chunksAfterUpdate = driver.magenta.pkb!.getAllChunks();
      expect(chunksAfterUpdate).toMatchSnapshot("after modifying section two");
    },
  );
});

it("should delete embeddings when file is removed", async () => {
  let tmpDirPath: string;

  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        tmpDirPath = tmpDir;
        const pkbDir = path.join(tmpDir, "pkb");
        await fs.mkdir(pkbDir);
        await fs.writeFile(
          path.join(pkbDir, "test.md"),
          "# Test Document\n\nThis is test content.",
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

      // Initial indexing
      const reindexPromise = driver.magenta.pkbManager!.reindex();
      await respondToContextRequests(driver, ["Context for test"]);
      const embedRequest = await awaitEmbedRequest(driver);
      const chunks = embedRequest.input as string[];
      respondToEmbedRequest(
        embedRequest,
        chunks.map(() => [0.1, 0.2, 0.3]),
      );
      await reindexPromise;

      const statsAfterIndex = driver.magenta.pkb!.getStats();
      expect(statsAfterIndex.totalFiles).toBe(1);
      expect(statsAfterIndex.totalChunks).toBeGreaterThan(0);

      // Delete the file
      await fs.unlink(path.join(tmpDirPath!, "pkb", "test.md"));

      // Trigger reindex
      await driver.magenta.pkbManager!.reindex();

      const statsAfterDelete = driver.magenta.pkb!.getStats();
      expect(statsAfterDelete.totalFiles).toBe(0);
      expect(statsAfterDelete.totalChunks).toBe(0);
    },
  );
});
