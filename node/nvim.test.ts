import { describe, it, expect } from "vitest";
import { withDriver } from "./test/preamble.ts";
import { getQuickfixList, quickfixListToString } from "./nvim/nvim.ts";

describe("node/nvim.test.ts", () => {
  it("should populate quickfix list and fetch it from node side", async () => {
    await withDriver({}, async (driver) => {
      // Create some test files and populate quickfix list
      await driver.nvim.call("nvim_command", [
        "call setqflist([" +
          "{'filename': 'test1.ts', 'lnum': 10, 'col': 5, 'text': 'Error: undefined variable'}," +
          "{'filename': 'test2.js', 'lnum': 25, 'col': 12, 'text': 'Warning: unused import'}," +
          "{'bufnr': 1, 'lnum': 1, 'col': 1, 'text': 'Info: buffer without filename'}" +
          "])",
      ]);

      // Fetch quickfix list from node side
      const qflist = await getQuickfixList(driver.nvim);

      // Verify the structure - note that filename entries get converted to bufnr
      expect(qflist).toHaveLength(3);
      expect(qflist[0]).toMatchObject({
        lnum: 10,
        col: 5,
        text: "Error: undefined variable",
      });
      expect(qflist[1]).toMatchObject({
        lnum: 25,
        col: 12,
        text: "Warning: unused import",
      });
      expect(qflist[2]).toMatchObject({
        bufnr: 1,
        lnum: 1,
        col: 1,
        text: "Info: buffer without filename",
      });

      // Test stringification
      const qfString = await quickfixListToString(qflist, driver.nvim);
      const lines = qfString.split("\n");

      expect(lines).toHaveLength(3);
      // Check that the lines contain the expected text (exact filename may vary)
      expect(lines[0]).toContain("Error: undefined variable");
      expect(lines[1]).toContain("Warning: unused import");
      expect(lines[2]).toContain("Info: buffer without filename");
    });
  });

  it("should handle empty quickfix list", async () => {
    await withDriver({}, async (driver) => {
      // Clear quickfix list
      await driver.nvim.call("nvim_command", ["call setqflist([])"]);

      // Fetch empty quickfix list
      const qflist = await getQuickfixList(driver.nvim);
      expect(qflist).toHaveLength(0);

      // Test stringification of empty list
      const qfString = await quickfixListToString(qflist, driver.nvim);
      expect(qfString).toBe("");
    });
  });

  it("should handle quickfix entries with missing line/col numbers", async () => {
    await withDriver({}, async (driver) => {
      // Create quickfix entries with missing line/col
      await driver.nvim.call("nvim_command", [
        "call setqflist([" +
          "{'filename': 'test.ts', 'lnum': 0, 'col': 0, 'text': 'File-level error'}," +
          "{'filename': 'test2.ts', 'lnum': 15, 'col': 0, 'text': 'Line-level error'}" +
          "])",
      ]);

      const qflist = await getQuickfixList(driver.nvim);
      const qfString = await quickfixListToString(qflist, driver.nvim);
      const lines = qfString.split("\n");

      expect(lines[0]).toContain("File-level error");
      expect(lines[1]).toContain("Line-level error");
      // Check that missing line/col are handled correctly
      expect(lines[0]).not.toContain(":0");
      expect(lines[1]).toContain(":15");
    });
  });
});
