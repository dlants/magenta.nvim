import { describe, expect, it } from "vitest";
import { withDriver } from "../test/preamble";
import { FileSnapshots } from "./file-snapshots";
import * as path from "path";
import * as fs from "node:fs";
import { getcwd } from "../nvim/nvim";
import type { AbsFilePath, UnresolvedFilePath } from "../utils/files.ts";

describe("FileSnapshots", () => {
  it("should create a snapshot for a file that exists", async () => {
    await withDriver({}, async (driver) => {
      const cwd = await getcwd(driver.nvim);
      const filePath = path.join(cwd, "test-file.txt");
      const fileContent = "This is a test file content";
      fs.writeFileSync(filePath, fileContent);

      const fileSnapshots = new FileSnapshots(driver.nvim, cwd);
      const turn = fileSnapshots.startNewTurn();

      const result = await fileSnapshots.willEditFile(
        filePath as UnresolvedFilePath,
      );

      expect(result).toBe(true);

      const snapshot = fileSnapshots.getSnapshot(filePath as AbsFilePath, turn);
      expect(snapshot).toBeDefined();
      expect(snapshot?.content).toEqual(fileContent);
    });
  });

  it("should create an empty snapshot for a file that doesn't exist", async () => {
    await withDriver({}, async (driver) => {
      const cwd = await getcwd(driver.nvim);
      const nonExistentPath = path.join(cwd, "non-existent.txt");

      const fileSnapshots = new FileSnapshots(driver.nvim, cwd);
      const turn = fileSnapshots.startNewTurn();

      const result = await fileSnapshots.willEditFile(
        nonExistentPath as UnresolvedFilePath,
      );

      expect(result).toBe(true);

      const snapshot = fileSnapshots.getSnapshot(
        nonExistentPath as AbsFilePath,
        turn,
      );
      expect(snapshot).toBeDefined();
      expect(snapshot?.content).toEqual("");
    });
  });

  it("should not create a duplicate snapshot for the same file in the same turn", async () => {
    await withDriver({}, async (driver) => {
      const cwd = await getcwd(driver.nvim);
      const filePath = path.join(cwd, "duplicate-test.txt");
      const fileContent = "Original content";
      fs.writeFileSync(filePath, fileContent);

      const fileSnapshots = new FileSnapshots(driver.nvim, cwd);
      const turn = fileSnapshots.startNewTurn();

      // First snapshot
      const firstResult = await fileSnapshots.willEditFile(
        filePath as UnresolvedFilePath,
      );
      expect(firstResult).toBe(true);

      // Change the file
      fs.writeFileSync(filePath, "Modified content");

      // Try to create another snapshot in the same turn
      const secondResult = await fileSnapshots.willEditFile(
        filePath as UnresolvedFilePath,
      );
      expect(secondResult).toBe(false);

      // Verify it's still the original snapshot
      const snapshot = fileSnapshots.getSnapshot(filePath as AbsFilePath, turn);
      expect(snapshot?.content).toEqual(fileContent);
    });
  });

  it("should create different snapshots for different turns", async () => {
    await withDriver({}, async (driver) => {
      const cwd = await getcwd(driver.nvim);
      const filePath = path.join(cwd, "multiple-turns.txt");
      const initialContent = "Initial content";
      fs.writeFileSync(filePath, initialContent);

      const fileSnapshots = new FileSnapshots(driver.nvim, cwd);

      // First turn
      const turn1 = fileSnapshots.startNewTurn();
      await fileSnapshots.willEditFile(filePath as UnresolvedFilePath);

      // Change file
      const updatedContent = "Updated content";
      fs.writeFileSync(filePath, updatedContent);

      // Second turn
      const turn2 = fileSnapshots.startNewTurn();
      await fileSnapshots.willEditFile(filePath as UnresolvedFilePath);

      const snapshot1 = fileSnapshots.getSnapshot(
        filePath as AbsFilePath,
        turn1,
      );
      const snapshot2 = fileSnapshots.getSnapshot(
        filePath as AbsFilePath,
        turn2,
      );

      expect(snapshot1?.content).toEqual(initialContent);
      expect(snapshot2?.content).toEqual(updatedContent);
    });
  });

  it("should clear all snapshots when clearSnapshots is called with no arguments", async () => {
    await withDriver({}, async (driver) => {
      const cwd = await getcwd(driver.nvim);
      const file1 = path.join(cwd, "file1.txt");
      const file2 = path.join(cwd, "file2.txt");

      fs.writeFileSync(file1, "File 1 content");
      fs.writeFileSync(file2, "File 2 content");

      const fileSnapshots = new FileSnapshots(driver.nvim, cwd);

      // First turn
      const turn1 = fileSnapshots.startNewTurn();
      await fileSnapshots.willEditFile(file1 as UnresolvedFilePath);
      await fileSnapshots.willEditFile(file2 as UnresolvedFilePath);

      // Second turn
      const turn2 = fileSnapshots.startNewTurn();
      await fileSnapshots.willEditFile(file1 as UnresolvedFilePath);

      // Clear all snapshots
      fileSnapshots.clearSnapshots();

      expect(
        fileSnapshots.getSnapshot(file1 as AbsFilePath, turn1),
      ).toBeUndefined();
      expect(
        fileSnapshots.getSnapshot(file2 as AbsFilePath, turn1),
      ).toBeUndefined();
      expect(
        fileSnapshots.getSnapshot(file1 as AbsFilePath, turn2),
      ).toBeUndefined();
    });
  });

  it("should clear only snapshots for a specific turn", async () => {
    await withDriver({}, async (driver) => {
      const cwd = await getcwd(driver.nvim);
      const file1 = path.join(cwd, "file1.txt");
      const file2 = path.join(cwd, "file2.txt");

      fs.writeFileSync(file1, "File 1 content");
      fs.writeFileSync(file2, "File 2 content");

      const fileSnapshots = new FileSnapshots(driver.nvim, cwd);

      // First turn
      const turn1 = fileSnapshots.startNewTurn();
      await fileSnapshots.willEditFile(file1 as UnresolvedFilePath);
      await fileSnapshots.willEditFile(file2 as UnresolvedFilePath);

      // Second turn
      const turn2 = fileSnapshots.startNewTurn();
      await fileSnapshots.willEditFile(file1 as UnresolvedFilePath);

      // Clear only turn1 snapshots
      fileSnapshots.clearSnapshots(turn1);

      expect(
        fileSnapshots.getSnapshot(file1 as AbsFilePath, turn1),
      ).toBeUndefined();
      expect(
        fileSnapshots.getSnapshot(file2 as AbsFilePath, turn1),
      ).toBeUndefined();
      expect(
        fileSnapshots.getSnapshot(file1 as AbsFilePath, turn2),
      ).toBeDefined();
    });
  });

  it("should get content from buffer when file is open", async () => {
    await withDriver({}, async (driver) => {
      const cwd = await getcwd(driver.nvim);
      const filePath = path.join(cwd, "buffer-test.txt");
      const fileContent = "Original file content";
      fs.writeFileSync(filePath, fileContent);

      // Open the file in a buffer and modify it
      await driver.command(`edit ${filePath}`);
      await driver.command("normal! ggdGiBuffer content that is different");

      // Create FileSnapshots instance
      const fileSnapshots = new FileSnapshots(driver.nvim, cwd);
      const turn = fileSnapshots.startNewTurn();

      // Create snapshot - should use buffer content, not file content
      await fileSnapshots.willEditFile(filePath as UnresolvedFilePath);

      const snapshot = fileSnapshots.getSnapshot(filePath as AbsFilePath, turn);
      expect(snapshot).toBeDefined();
      expect(snapshot?.content).toEqual("Buffer content that is different");

      // Verify the file on disk still has the original content
      const diskContent = fs.readFileSync(filePath, "utf-8");
      expect(diskContent).toEqual(fileContent);
    });
  });

  it("should use current turn when getting snapshot without specifying turn", async () => {
    await withDriver({}, async (driver) => {
      const cwd = await getcwd(driver.nvim);
      const filePath = path.join(cwd, "current-turn-test.txt");
      const fileContent = "Test content";
      fs.writeFileSync(filePath, fileContent);

      const fileSnapshots = new FileSnapshots(driver.nvim, cwd);
      fileSnapshots.startNewTurn();

      await fileSnapshots.willEditFile(filePath as UnresolvedFilePath);

      // Get snapshot without specifying turn - should use current turn
      const snapshot = fileSnapshots.getSnapshot(filePath as AbsFilePath);
      expect(snapshot).toBeDefined();
      expect(snapshot?.content).toEqual(fileContent);
    });
  });
});
