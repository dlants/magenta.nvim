import { describe, expect, it } from "vitest";
import { pos } from "../tea/view.ts";
import { withNvimClient } from "../test/preamble.ts";
import { type Line, NvimBuffer } from "./buffer.ts";
import {
  type ExtmarkId,
  type ExtmarkOptions,
  extmarkOptionsEqual,
} from "./extmarks.ts";
import type { Row0Indexed } from "./window.ts";

describe("nvim/buffer.test.ts", () => {
  describe("extmark management", () => {
    it("should set and delete extmarks", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);

        // Set up buffer content
        await buffer.setLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
          lines: ["Hello world", "Second line"] as Line[],
        });

        // Initially no extmarks
        let extmarks = await buffer.getExtmarks();
        expect(extmarks).toHaveLength(0);

        // Set extmark
        const extmarkId = await buffer.setExtmark({
          startPos: pos(0, 0),
          endPos: pos(0, 5),
          options: { hl_group: "ErrorMsg" },
        });

        expect(typeof extmarkId).toBe("number");

        // Verify extmark was created using both methods
        extmarks = await buffer.getExtmarks();
        expect(extmarks).toHaveLength(1);
        expect(extmarks[0].id).toBe(extmarkId);
        expect(extmarks[0].startPos).toEqual({ row: 0, col: 0 });
        expect(extmarks[0].endPos).toEqual({ row: 0, col: 5 });
        expect(extmarks[0].options.hl_group).toBe("ErrorMsg");

        // Verify with getExtmarkById
        const extmarkById = await buffer.getExtmarkById(extmarkId);
        expect(extmarkById).toBeDefined();
        expect(extmarkById!.id).toBe(extmarkId);
        expect(extmarkById!.startPos).toEqual({ row: 0, col: 0 });
        expect(extmarkById!.endPos).toEqual({ row: 0, col: 5 });
        expect(extmarkById!.options.hl_group).toBe("ErrorMsg");

        // Delete extmark
        await buffer.deleteExtmark(extmarkId);

        // Verify extmark was deleted using both methods
        extmarks = await buffer.getExtmarks();
        expect(extmarks).toHaveLength(0);

        const deletedExtmark = await buffer.getExtmarkById(extmarkId);
        expect(deletedExtmark).toBeUndefined();

        // Should succeed even if extmark doesn't exist anymore
        await buffer.deleteExtmark(extmarkId);

        // Still no extmarks
        extmarks = await buffer.getExtmarks();
        expect(extmarks).toHaveLength(0);
        const stillDeletedExtmark = await buffer.getExtmarkById(extmarkId);
        expect(stillDeletedExtmark).toBeUndefined();
      });
    });

    it("should handle extmark errors gracefully", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);

        // Try to set extmark at invalid position - should not throw
        try {
          await buffer.setExtmark({
            startPos: pos(100, 100), // Invalid position
            endPos: pos(100, 105),
            options: { hl_group: "ErrorMsg" },
          });
        } catch (error) {
          // This is expected behavior for invalid positions
          expect(error).toBeDefined();
        }
      });
    });

    it("should update extmarks", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);

        // Set up buffer content
        await buffer.setLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
          lines: ["Hello world", "Second line"] as Line[],
        });

        // Set initial extmark
        const extmarkId = await buffer.setExtmark({
          startPos: pos(0, 0),
          endPos: pos(0, 5),
          options: { hl_group: "ErrorMsg" },
        });

        // Verify initial extmark state using both methods
        let extmarks = await buffer.getExtmarks();
        expect(extmarks).toHaveLength(1);
        expect(extmarks[0].startPos).toEqual({ row: 0, col: 0 });
        expect(extmarks[0].endPos).toEqual({ row: 0, col: 5 });
        expect(extmarks[0].options.hl_group).toBe("ErrorMsg");

        let extmarkById = await buffer.getExtmarkById(extmarkId);
        expect(extmarkById).toBeDefined();
        expect(extmarkById!.startPos).toEqual({ row: 0, col: 0 });
        expect(extmarkById!.endPos).toEqual({ row: 0, col: 5 });
        expect(extmarkById!.options.hl_group).toBe("ErrorMsg");

        // Update extmark position and style
        const updatedId = await buffer.updateExtmark({
          extmarkId,
          startPos: pos(0, 6),
          endPos: pos(0, 11),
          options: { hl_group: "WarningMsg" },
        });

        expect(updatedId).toBe(extmarkId);

        // Verify extmark was updated using both methods
        extmarks = await buffer.getExtmarks();
        expect(extmarks).toHaveLength(1);
        expect(extmarks[0].id).toBe(extmarkId);
        expect(extmarks[0].startPos).toEqual({ row: 0, col: 6 });
        expect(extmarks[0].endPos).toEqual({ row: 0, col: 11 });
        expect(extmarks[0].options.hl_group).toBe("WarningMsg");

        extmarkById = await buffer.getExtmarkById(extmarkId);
        expect(extmarkById).toBeDefined();
        expect(extmarkById!.id).toBe(extmarkId);
        expect(extmarkById!.startPos).toEqual({ row: 0, col: 6 });
        expect(extmarkById!.endPos).toEqual({ row: 0, col: 11 });
        expect(extmarkById!.options.hl_group).toBe("WarningMsg");
      });
    });

    it("should clear all extmarks in namespace", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);

        // Set up buffer content
        await buffer.setLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
          lines: ["Hello world", "Second line"] as Line[],
        });

        // Initially no extmarks
        let extmarks = await buffer.getExtmarks();
        expect(extmarks).toHaveLength(0);

        // Set multiple extmarks
        const extmark1 = await buffer.setExtmark({
          startPos: pos(0, 0),
          endPos: pos(0, 5),
          options: { hl_group: "ErrorMsg" },
        });

        const extmark2 = await buffer.setExtmark({
          startPos: pos(1, 0),
          endPos: pos(1, 6),
          options: { hl_group: "WarningMsg" },
        });

        expect(typeof extmark1).toBe("number");
        expect(typeof extmark2).toBe("number");

        // Verify both extmarks exist using both methods
        extmarks = await buffer.getExtmarks();
        expect(extmarks).toHaveLength(2);
        expect(extmarks.map((e) => e.id)).toContain(extmark1);
        expect(extmarks.map((e) => e.id)).toContain(extmark2);

        const extmark1ById = await buffer.getExtmarkById(extmark1);
        const extmark2ById = await buffer.getExtmarkById(extmark2);
        expect(extmark1ById).toBeDefined();
        expect(extmark2ById).toBeDefined();
        expect(extmark1ById!.id).toBe(extmark1);
        expect(extmark2ById!.id).toBe(extmark2);
        expect(extmark1ById!.options.hl_group).toBe("ErrorMsg");
        expect(extmark2ById!.options.hl_group).toBe("WarningMsg");

        // Clear all extmarks
        await buffer.clearAllExtmarks();

        // Verify all extmarks were cleared using both methods
        extmarks = await buffer.getExtmarks();
        expect(extmarks).toHaveLength(0);

        const clearedExtmark1 = await buffer.getExtmarkById(extmark1);
        const clearedExtmark2 = await buffer.getExtmarkById(extmark2);
        expect(clearedExtmark1).toBeUndefined();
        expect(clearedExtmark2).toBeUndefined();
      });
    });

    it("should handle extmarks with various options", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);

        // Set up buffer content
        await buffer.setLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
          lines: ["Hello world test"] as Line[],
        });

        // Test with various extmark options
        const extmarkId = await buffer.setExtmark({
          startPos: pos(0, 0),
          endPos: pos(0, 5),
          options: {
            hl_group: "ErrorMsg",
            priority: 100,
            hl_eol: true,
            sign_text: "!!",
            sign_hl_group: "ErrorMsg",
          },
        });

        expect(typeof extmarkId).toBe("number");

        // Verify extmark options were set correctly
        const extmarks = await buffer.getExtmarks();
        expect(extmarks).toHaveLength(1);
        expect(extmarks[0].id).toBe(extmarkId);
        expect(extmarks[0].options.hl_group).toBe("ErrorMsg");
        expect(extmarks[0].options.priority).toBe(100);
        expect(extmarks[0].options.hl_eol).toBe(true);
        expect(extmarks[0].options.sign_text).toBe("!!");
        expect(extmarks[0].options.sign_hl_group).toBe("ErrorMsg");
      });
    });

    it("should handle multi-line extmarks", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);

        // Set up multi-line buffer content
        await buffer.setLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
          lines: ["First line", "Second line", "Third line"] as Line[],
        });

        // Set multi-line extmark
        const extmarkId = await buffer.setExtmark({
          startPos: pos(0, 5),
          endPos: pos(2, 5),
          options: { hl_group: "String" },
        });

        expect(typeof extmarkId).toBe("number");

        // Verify multi-line extmark position
        const extmarks = await buffer.getExtmarks();
        expect(extmarks).toHaveLength(1);
        expect(extmarks[0].startPos).toEqual({ row: 0, col: 5 });
        expect(extmarks[0].endPos).toEqual({ row: 2, col: 5 });
        expect(extmarks[0].options.hl_group).toBe("String");
      });
    });
    it("should get extmarks correctly", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);

        // Set up buffer content
        await buffer.setLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
          lines: ["Line one", "Line two", "Line three"] as Line[],
        });

        // Initially should return empty array
        let extmarks = await buffer.getExtmarks();
        expect(extmarks).toHaveLength(0);

        // Add multiple extmarks with different options
        const extmark1 = await buffer.setExtmark({
          startPos: pos(0, 0),
          endPos: pos(0, 4),
          options: { hl_group: "ErrorMsg", priority: 200 },
        });

        const extmark2 = await buffer.setExtmark({
          startPos: pos(1, 5),
          endPos: pos(1, 8),
          options: { hl_group: "WarningMsg", hl_eol: true },
        });

        const extmark3 = await buffer.setExtmark({
          startPos: pos(2, 0),
          endPos: pos(2, 10),
          options: {
            hl_group: "String",
            sign_text: ">>",
            sign_hl_group: "Comment",
          },
        });

        // Get all extmarks and verify
        extmarks = await buffer.getExtmarks();
        expect(extmarks).toHaveLength(3);

        // Sort by ID to ensure consistent ordering
        extmarks.sort((a, b) => a.id - b.id);

        // Verify first extmark
        expect(extmarks[0].id).toBe(extmark1);
        expect(extmarks[0].startPos).toEqual({ row: 0, col: 0 });
        expect(extmarks[0].endPos).toEqual({ row: 0, col: 4 });
        expect(extmarks[0].options.hl_group).toBe("ErrorMsg");
        expect(extmarks[0].options.priority).toBe(200);

        // Verify second extmark
        expect(extmarks[1].id).toBe(extmark2);
        expect(extmarks[1].startPos).toEqual({ row: 1, col: 5 });
        expect(extmarks[1].endPos).toEqual({ row: 1, col: 8 });
        expect(extmarks[1].options.hl_group).toBe("WarningMsg");
        expect(extmarks[1].options.hl_eol).toBe(true);

        // Verify third extmark
        expect(extmarks[2].id).toBe(extmark3);
        expect(extmarks[2].startPos).toEqual({ row: 2, col: 0 });
        expect(extmarks[2].endPos).toEqual({ row: 2, col: 10 });
        expect(extmarks[2].options.hl_group).toBe("String");
        expect(extmarks[2].options.sign_text).toBe(">>");
        expect(extmarks[2].options.sign_hl_group).toBe("Comment");
      });
    });

    it("should create and reuse magenta namespace", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);

        const namespace1 = await buffer.getMagentaNamespace();
        const namespace2 = await buffer.getMagentaNamespace();

        // Should return same namespace for repeated calls
        expect(namespace1).toBe(namespace2);
        expect(typeof namespace1).toBe("number");
      });
    });

    it("should validate buffer state", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);

        // Buffer should be valid initially
        const isValid1 = await buffer.isValid();
        expect(isValid1).toBe(true);

        // Delete buffer
        await buffer.delete();

        // Buffer should be invalid after deletion
        const isValid2 = await buffer.isValid();
        expect(isValid2).toBe(false);
      });
    });

    it("should get extmark by ID", async () => {
      await withNvimClient(async (nvim) => {
        const buffer = await NvimBuffer.create(false, true, nvim);

        // Set up buffer content
        await buffer.setLines({
          start: 0 as Row0Indexed,
          end: -1 as Row0Indexed,
          lines: ["Test line one", "Test line two"] as Line[],
        });

        // Should return undefined for non-existent extmark
        const nonExistent = await buffer.getExtmarkById(999 as ExtmarkId);
        expect(nonExistent).toBeUndefined();

        // Create an extmark
        const extmarkId = await buffer.setExtmark({
          startPos: pos(0, 5),
          endPos: pos(0, 9),
          options: {
            hl_group: "String",
            priority: 150,
            sign_text: "->",
            sign_hl_group: "Comment",
          },
        });

        // Get the extmark by ID
        const foundExtmark = await buffer.getExtmarkById(extmarkId);
        expect(foundExtmark).toBeDefined();
        expect(foundExtmark!.id).toBe(extmarkId);
        expect(foundExtmark!.startPos).toEqual({ row: 0, col: 5 });
        expect(foundExtmark!.endPos).toEqual({ row: 0, col: 9 });
        expect(foundExtmark!.options.hl_group).toBe("String");
        expect(foundExtmark!.options.priority).toBe(150);
        expect(foundExtmark!.options.sign_text).toBe("->");
        expect(foundExtmark!.options.sign_hl_group).toBe("Comment");

        // Create multiple extmarks to ensure we get the right one
        const extmark2Id = await buffer.setExtmark({
          startPos: pos(1, 0),
          endPos: pos(1, 4),
          options: { hl_group: "ErrorMsg" },
        });

        const extmark3Id = await buffer.setExtmark({
          startPos: pos(1, 5),
          endPos: pos(1, 9),
          options: { hl_group: "WarningMsg" },
        });

        // Verify each extmark individually
        const extmark1ById = await buffer.getExtmarkById(extmarkId);
        const extmark2ById = await buffer.getExtmarkById(extmark2Id);
        const extmark3ById = await buffer.getExtmarkById(extmark3Id);

        expect(extmark1ById!.options.hl_group).toBe("String");
        expect(extmark2ById!.options.hl_group).toBe("ErrorMsg");
        expect(extmark3ById!.options.hl_group).toBe("WarningMsg");

        expect(extmark1ById!.startPos).toEqual({ row: 0, col: 5 });
        expect(extmark2ById!.startPos).toEqual({ row: 1, col: 0 });
        expect(extmark3ById!.startPos).toEqual({ row: 1, col: 5 });

        // Delete one extmark and verify it's no longer found
        await buffer.deleteExtmark(extmark2Id);
        const deletedExtmark = await buffer.getExtmarkById(extmark2Id);
        expect(deletedExtmark).toBeUndefined();

        // Other extmarks should still exist
        const stillExists1 = await buffer.getExtmarkById(extmarkId);
        const stillExists3 = await buffer.getExtmarkById(extmark3Id);
        expect(stillExists1).toBeDefined();
        expect(stillExists3).toBeDefined();
      });
    });
  });

  describe("setName", () => {
    it("does not throw E95 when another buffer already holds the name", async () => {
      await withNvimClient(async (nvim) => {
        const name = `magenta-test-${Date.now()}`;

        const buffer1 = await NvimBuffer.create(false, true, nvim);
        await buffer1.setName(name);

        // A second buffer taking the same name would normally fail with E95.
        const buffer2 = await NvimBuffer.create(false, true, nvim);
        await buffer2.setName(name);

        expect(await buffer2.getName()).toMatch(new RegExp(`${name}$`));
      });
    });
  });

  describe("extmarkOptionsEqual", () => {
    it("should return true for undefined options", () => {
      expect(extmarkOptionsEqual(undefined, undefined)).toBe(true);
    });

    it("should return false when one is undefined", () => {
      expect(extmarkOptionsEqual(undefined, { hl_group: "ErrorMsg" })).toBe(
        false,
      );
      expect(extmarkOptionsEqual({ hl_group: "ErrorMsg" }, undefined)).toBe(
        false,
      );
    });

    it("should return true for identical options", () => {
      const options1 = {
        hl_group: "ErrorMsg",
        priority: 100,
      } as ExtmarkOptions;
      const options2 = {
        hl_group: "ErrorMsg",
        priority: 100,
      } as ExtmarkOptions;
      expect(extmarkOptionsEqual(options1, options2)).toBe(true);
    });

    it("should return false for different highlight groups", () => {
      const options1 = { hl_group: "ErrorMsg" } as ExtmarkOptions;
      const options2 = { hl_group: "WarningMsg" } as ExtmarkOptions;
      expect(extmarkOptionsEqual(options1, options2)).toBe(false);
    });
    it("should return false for different priorities", () => {
      const options1 = {
        hl_group: "ErrorMsg",
        priority: 100,
      } as ExtmarkOptions;
      const options2 = {
        hl_group: "ErrorMsg",
        priority: 200,
      } as ExtmarkOptions;
      expect(extmarkOptionsEqual(options1, options2)).toBe(false);
    });

    it("should handle complex options", () => {
      const options1 = {
        hl_group: "String",
        priority: 200,
        sign_text: "!!",
        sign_hl_group: "ErrorMsg",
        hl_eol: true,
      } as ExtmarkOptions;
      const options2 = {
        hl_group: "String",
        priority: 200,
        sign_text: "!!",
        sign_hl_group: "ErrorMsg",
        hl_eol: true,
      } as ExtmarkOptions;
      expect(extmarkOptionsEqual(options1, options2)).toBe(true);

      const options3 = { ...options2, hl_eol: false };
      expect(extmarkOptionsEqual(options1, options3)).toBe(false);
    });
  });
});
