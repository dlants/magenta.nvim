import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { AbsFilePath, HomeDir, NvimCwd } from "@magenta/server";
import { describe, expect, it } from "vitest";
import { withDriver } from "../test/preamble.ts";
import { discoverHierarchyContext } from "./auto-context.ts";

describe("discoverHierarchyContext", () => {
  it("walks up from a nested file finding context.md at each ancestor level", async () => {
    await withDriver(
      {
        setupFiles: async (tmpDir) => {
          await fsPromises.mkdir(path.join(tmpDir, "a", "b", "c"), {
            recursive: true,
          });
          await fsPromises.writeFile(
            path.join(tmpDir, "a", "b", "c", "leaf.txt"),
            "leaf",
          );
          await fsPromises.writeFile(
            path.join(tmpDir, "a", "b", "context.md"),
            "B context",
          );
          await fsPromises.writeFile(
            path.join(tmpDir, "a", "context.md"),
            "A context",
          );
        },
      },
      async (driver, dirs) => {
        const leafAbs = path.join(
          dirs.tmpDir,
          "a",
          "b",
          "c",
          "leaf.txt",
        ) as AbsFilePath;

        const results = await discoverHierarchyContext(leafAbs, {
          nvim: driver.nvim,
          cwd: dirs.tmpDir as NvimCwd,
          homeDir: dirs.homeDir as HomeDir,
          options: driver.magenta.options,
        });

        const relPaths = results.map((r) => r.relFilePath).sort();
        expect(relPaths).toContain("a/b/context.md");
        expect(relPaths).toContain("a/context.md");
      },
    );
  });

  it("returns empty array when hierarchyContextFileNames is empty", async () => {
    await withDriver(
      {
        options: { hierarchyContextFileNames: [] },
        setupFiles: async (tmpDir) => {
          await fsPromises.mkdir(path.join(tmpDir, "a"), { recursive: true });
          await fsPromises.writeFile(
            path.join(tmpDir, "a", "leaf.txt"),
            "leaf",
          );
          await fsPromises.writeFile(
            path.join(tmpDir, "a", "context.md"),
            "ctx",
          );
        },
      },
      async (driver, dirs) => {
        const leafAbs = path.join(dirs.tmpDir, "a", "leaf.txt") as AbsFilePath;
        const results = await discoverHierarchyContext(leafAbs, {
          nvim: driver.nvim,
          cwd: dirs.tmpDir as NvimCwd,
          homeDir: dirs.homeDir as HomeDir,
          options: driver.magenta.options,
        });
        expect(results).toEqual([]);
      },
    );
  });
});
