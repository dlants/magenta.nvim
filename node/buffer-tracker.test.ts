import { describe, expect, it } from "vitest";
import { withDriver } from "./test/preamble.ts";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "util";
import { getCurrentBuffer } from "./nvim/nvim.ts";
import type { AbsFilePath } from "./utils/files.ts";
import type { Line } from "./nvim/buffer.ts";
import type { Row0Indexed } from "./nvim/window.ts";

const writeFile = promisify(fs.writeFile);

describe("node/buffer-tracker.test.ts", () => {
  it("should track buffer as not modified after initial read", async () => {
    await withDriver({}, async (driver) => {
      // Create a temporary file for testing
      const filePath = path.join(
        driver.magenta.cwd,
        "test-file.txt",
      ) as AbsFilePath;
      await writeFile(filePath, "initial content");

      await driver.editFile(filePath);
      const buffer = await getCurrentBuffer(driver.nvim);

      // Check buffer name matches the file path
      const bufferName = await buffer.getName();
      expect(bufferName).toContain(filePath);

      // Get tracker and verify it's tracking the buffer
      const bufferTracker = driver.magenta.bufferTracker;
      await bufferTracker.trackBufferSync(filePath, buffer.id);

      // Check buffer is not modified
      const isModified = await bufferTracker.isBufferModifiedSinceSync(
        filePath,
        buffer.id,
      );
      expect(isModified).toBe(false);

      // Verify sync info exists
      const syncInfo = bufferTracker.getSyncInfo(filePath);
      expect(syncInfo).toBeDefined();
      expect(syncInfo?.bufnr).toBe(buffer.id);
    });
  });

  it("should detect buffer as modified after edits without saving", async () => {
    await withDriver({}, async (driver) => {
      // Create a temporary file for testing
      const filePath = path.join(
        driver.magenta.cwd,
        "test-file-modified.txt",
      ) as AbsFilePath;
      await writeFile(filePath, "initial content");

      // Edit the file
      await driver.editFile(filePath);
      const buffer = await getCurrentBuffer(driver.nvim);

      // Check buffer name matches the file path
      const bufferName = await buffer.getName();
      expect(bufferName).toContain(filePath);

      // Get tracker and initial state
      const bufferTracker = driver.magenta.bufferTracker;
      await bufferTracker.trackBufferSync(filePath, buffer.id);
      const initialSyncInfo = bufferTracker.getSyncInfo(filePath);

      // Modify the buffer without saving
      await buffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["modified content" as Line],
      });

      // Check buffer is detected as modified
      const isModified = await bufferTracker.isBufferModifiedSinceSync(
        filePath,
        buffer.id,
      );
      expect(isModified).toBe(true);

      // Verify mtime hasn't changed
      const currentSyncInfo = bufferTracker.getSyncInfo(filePath);
      expect(currentSyncInfo?.mtime).toBe(initialSyncInfo?.mtime);
    });
  });

  it("should update sync info after writing changes to disk", async () => {
    await withDriver({}, async (driver) => {
      // Create a temporary file for testing
      const filePath = path.join(
        driver.magenta.cwd,
        "test-file-write.txt",
      ) as AbsFilePath;
      await writeFile(filePath, "initial content");

      // Edit the file
      await driver.editFile(filePath);
      const buffer = await getCurrentBuffer(driver.nvim);

      // Check buffer name matches the file path
      const bufferName = await buffer.getName();
      expect(bufferName).toContain(filePath);

      // Get tracker and initial state
      const bufferTracker = driver.magenta.bufferTracker;
      await bufferTracker.trackBufferSync(filePath, buffer.id);
      const initialSyncInfo = bufferTracker.getSyncInfo(filePath);

      // Modify the buffer
      await buffer.setLines({
        start: 0 as Row0Indexed,
        end: -1 as Row0Indexed,
        lines: ["modified content" as Line],
      });

      // Save the buffer
      await driver.command("write");

      // Track the sync again
      await bufferTracker.trackBufferSync(filePath, buffer.id);

      // Check buffer is no longer modified
      const isModified = await bufferTracker.isBufferModifiedSinceSync(
        filePath,
        buffer.id,
      );
      expect(isModified).toBe(false);

      // Verify mtime has changed
      const updatedSyncInfo = bufferTracker.getSyncInfo(filePath);
      expect(updatedSyncInfo?.mtime).toBeGreaterThan(
        initialSyncInfo?.mtime as number,
      );
    });
  });

  it("should clear tracking info when requested", async () => {
    await withDriver({}, async (driver) => {
      // Create a temporary file for testing
      const filePath = path.join(
        driver.magenta.cwd,
        "test-file-clear.txt",
      ) as AbsFilePath;
      await writeFile(filePath, "initial content");

      // Edit the file
      await driver.editFile(filePath);
      const buffer = await getCurrentBuffer(driver.nvim);

      // Check buffer name matches the file path
      const bufferName = await buffer.getName();
      expect(bufferName).toContain(filePath);

      // Get tracker and initial state
      const bufferTracker = driver.magenta.bufferTracker;
      await bufferTracker.trackBufferSync(filePath, buffer.id);

      // Verify sync info exists
      expect(bufferTracker.getSyncInfo(filePath)).toBeDefined();

      // Clear tracking info
      bufferTracker.clearFileTracking(filePath);

      // Verify sync info is gone
      expect(bufferTracker.getSyncInfo(filePath)).toBeUndefined();
    });
  });
});
