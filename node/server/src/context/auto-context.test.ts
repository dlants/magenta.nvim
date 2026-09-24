import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { glob } from "glob";
import { describe, expect, it } from "vitest";
import { FsFileIO } from "../capabilities/file-io.ts";
import { InMemoryFileIO } from "../edl/in-memory-file-io.ts";
import { noopLogger } from "../test-helpers.ts";
import type { AbsFilePath, HomeDir, NvimCwd } from "../utils/files.ts";
import {
  discoverHierarchyContext,
  globFiles,
  resolveAutoContext,
} from "./auto-context.ts";

const cwd = "/project" as NvimCwd;
const homeDir = "/home" as HomeDir;

describe("discoverHierarchyContext", () => {
  it("walks up from a nested file finding context.md at each ancestor level", async () => {
    const fileIO = new InMemoryFileIO({
      "/project/a/b/c/leaf.txt": "leaf",
      "/project/a/b/context.md": "B context",
      "/project/a/context.md": "A context",
    });
    const results = await discoverHierarchyContext(
      "/project/a/b/c/leaf.txt" as AbsFilePath,
      {
        fileIO,
        logger: noopLogger,
        cwd,
        homeDir,
        hierarchyContextFileNames: ["context.md", "agent.md"],
      },
    );
    const relPaths = results.map((r) => r.relFilePath).sort();
    expect(relPaths).toEqual(["a/b/context.md", "a/context.md"]);
  });

  it("skips unsupported context files and keeps walking upward", async () => {
    const fileIO = new InMemoryFileIO({
      "/project/a/b/leaf.txt": "leaf",
      "/project/a/b/context.md": `\u007fELF\u0002\u0001\u0001${"\u0000".repeat(60)}`,
      "/project/context.md": "root",
    });
    const results = await discoverHierarchyContext(
      "/project/a/b/leaf.txt" as AbsFilePath,
      {
        fileIO,
        logger: noopLogger,
        cwd,
        homeDir,
        hierarchyContextFileNames: ["context.md"],
      },
    );
    expect(results.map((r) => r.relFilePath)).toEqual(["context.md"]);
  });

  it("returns empty array when hierarchyContextFileNames is empty", async () => {
    const fileIO = new InMemoryFileIO({
      "/project/a/leaf.txt": "leaf",
      "/project/a/context.md": "ctx",
    });
    const results = await discoverHierarchyContext(
      "/project/a/leaf.txt" as AbsFilePath,
      {
        fileIO,
        logger: noopLogger,
        cwd,
        homeDir,
        hierarchyContextFileNames: [],
      },
    );
    expect(results).toEqual([]);
  });
});

describe("resolveAutoContext", () => {
  it("resolves default patterns case-insensitively, including ~/ and .magenta/*.md", async () => {
    const fileIO = new InMemoryFileIO({
      "/home/.magenta/context.md": "home",
      "/project/CONTEXT.md": "ctx",
      "/project/.magenta/a.md": "a",
      "/project/.magenta/b.txt": "b",
      "/project/.magenta/sub/c.md": "c",
      "/project/src/context.md": "nested",
    });
    const results = await resolveAutoContext({
      fileIO,
      logger: noopLogger,
      cwd,
      homeDir,
      globs: [
        "~/.magenta/context.md",
        "context.md",
        "claude.md",
        ".magenta/*.md",
      ],
    });
    expect(results.map((r) => r.absFilePath).sort()).toEqual([
      "/home/.magenta/context.md",
      "/project/.magenta/a.md",
      "/project/CONTEXT.md",
    ]);
  });

  it("dedups overlapping patterns lexically", async () => {
    const fileIO = new InMemoryFileIO({ "/project/context.md": "x" });
    const results = await resolveAutoContext({
      fileIO,
      logger: noopLogger,
      cwd,
      homeDir,
      globs: ["context.md", "**/context.md", "./context.md"],
    });
    expect(results.map((r) => r.absFilePath)).toEqual(["/project/context.md"]);
  });

  it("accepts symlinked duplicates (dedup does not resolve realpath)", async () => {
    const tmp = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-ctx-link-")),
    );
    try {
      await fsPromises.writeFile(path.join(tmp, "context.md"), "x");
      await fsPromises.symlink(
        path.join(tmp, "context.md"),
        path.join(tmp, "link.md"),
      );
      const results = await resolveAutoContext({
        fileIO: new FsFileIO(),
        logger: noopLogger,
        cwd: tmp as NvimCwd,
        homeDir,
        globs: ["context.md", "link.md"],
      });
      expect(results.map((r) => r.relFilePath).sort()).toEqual([
        "context.md",
        "link.md",
      ]);
    } finally {
      await fsPromises.rm(tmp, { recursive: true, force: true });
    }
  });

  it("returns nothing when no globs are configured", async () => {
    const fileIO = new InMemoryFileIO({ "/project/context.md": "x" });
    expect(
      await resolveAutoContext({
        fileIO,
        logger: noopLogger,
        cwd,
        homeDir,
        globs: [],
      }),
    ).toEqual([]);
  });
});

describe("globFiles parity with the glob package", () => {
  it("matches glob({nocase, nodir}) on a real tree", async () => {
    const tmp = await fsPromises.realpath(
      await fsPromises.mkdtemp(path.join(os.tmpdir(), "glob-parity-")),
    );
    try {
      const files = [
        "context.md",
        "Claude.md",
        ".magenta/a.md",
        ".magenta/B.MD",
        ".magenta/x.txt",
        ".magenta/sub/c.md",
        "src/context.md",
        "src/deep/x/context.md",
        ".hidden/context.md",
        "docs/readme.md",
      ];
      for (const f of files) {
        await fsPromises.mkdir(path.dirname(path.join(tmp, f)), {
          recursive: true,
        });
        await fsPromises.writeFile(path.join(tmp, f), f);
      }
      await fsPromises.mkdir(path.join(tmp, "dir.md"));

      const patterns = [
        "context.md",
        "claude.md",
        ".magenta/*.md",
        "*.md",
        "**/context.md",
        "src/**/*.md",
        "{docs,src}/*.md",
        "[cC]laude.md",
        "[!x]*.md",
        "docs/**",
        `../${path.basename(tmp)}/context.md`,
        "c?ntext.md",
        path.join(tmp, ".magenta/*.md"),
      ];
      const fileIO = new FsFileIO();
      for (const pattern of patterns) {
        const expected = (
          await glob(pattern, { cwd: tmp, nocase: true, nodir: true })
        )
          .map((m) => path.resolve(tmp, m).toLowerCase())
          .sort();
        // glob echoes magic-less patterns verbatim; we return on-disk casing.
        const actual = (await globFiles(fileIO, pattern, tmp))
          .map((p) => p.toLowerCase())
          .sort();
        expect(actual, pattern).toEqual(expected);
      }
    } finally {
      await fsPromises.rm(tmp, { recursive: true, force: true });
    }
  });
});
