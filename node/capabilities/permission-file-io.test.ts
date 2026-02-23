import { describe, test, expect, vi, beforeEach } from "vitest";
import { PermissionCheckingFileIO } from "./permission-file-io.ts";
import type { FileIO } from "@magenta/core";
import type { HomeDir, NvimCwd } from "../utils/files.ts";
import { MAGENTA_TEMP_DIR } from "../utils/files.ts";
import type { MagentaOptions, FilePermission } from "../options.ts";
import type { Nvim } from "../nvim/nvim-node";
import * as fs from "node:fs/promises";
import * as path from "path";
import os from "os";

const mockNvim = {
  logger: { error: () => {} },
} as unknown as Nvim;

const defaultOptions: MagentaOptions = {
  skillsPaths: [],
  getFileAutoAllowGlobs: [],
  filePermissions: [],
} as unknown as MagentaOptions;

function createMockFileIO(): FileIO & {
  readFile: ReturnType<typeof vi.fn>;
  readBinaryFile: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  fileExists: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  stat: ReturnType<typeof vi.fn>;
} {
  return {
    readFile: vi.fn().mockResolvedValue("file content"),
    readBinaryFile: vi.fn().mockResolvedValue(Buffer.from("binary")),
    writeFile: vi.fn().mockResolvedValue(undefined),
    fileExists: vi.fn().mockResolvedValue(true),
    mkdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtimeMs: 1000 }),
  };
}

const cwd = "/test/cwd" as NvimCwd;
const homeDir = "/test/home" as HomeDir;

function createPermissionIO(
  inner: FileIO,
  options: MagentaOptions = defaultOptions,
  onPendingChange: () => void = vi.fn(),
) {
  return new PermissionCheckingFileIO(
    inner,
    { cwd, homeDir, options, nvim: mockNvim },
    onPendingChange,
  );
}

describe("PermissionCheckingFileIO", () => {
  let mockIO: ReturnType<typeof createMockFileIO>;
  let onPendingChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockIO = createMockFileIO();
    onPendingChange = vi.fn();
  });

  describe("readFile - allowed paths", () => {
    test("delegates to inner FileIO immediately for files in cwd", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      const result = await pio.readFile("/test/cwd/src/file.ts");
      expect(result).toBe("file content");
      expect(mockIO.readFile).toHaveBeenCalledWith("/test/cwd/src/file.ts");
    });

    test("delegates immediately for files in magenta temp directory", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      const filePath = `${MAGENTA_TEMP_DIR}/threads/abc/tools/tool_1/bashCommand.log`;
      const result = await pio.readFile(filePath);
      expect(result).toBe("file content");
      expect(mockIO.readFile).toHaveBeenCalledWith(filePath);
    });

    test("delegates immediately for skills directory files", async () => {
      const options = {
        ...defaultOptions,
        skillsPaths: ["/test/skills"],
      } as unknown as MagentaOptions;
      const pio = createPermissionIO(mockIO, options, onPendingChange);
      const result = await pio.readFile("/test/skills/my-skill/skill.md");
      expect(result).toBe("file content");
      expect(mockIO.readFile).toHaveBeenCalledWith(
        "/test/skills/my-skill/skill.md",
      );
    });

    test("delegates immediately with filePermissions granting read", async () => {
      const options = {
        ...defaultOptions,
        filePermissions: [{ path: "/outside", read: true }] as FilePermission[],
      } as unknown as MagentaOptions;
      const pio = createPermissionIO(mockIO, options, onPendingChange);
      const result = await pio.readFile("/outside/file.txt");
      expect(result).toBe("file content");
      expect(mockIO.readFile).toHaveBeenCalledWith("/outside/file.txt");
    });
  });

  describe("readFile - denied paths", () => {
    test("blocks on files outside cwd without permission", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      let resolved = false;
      const promise = pio.readFile("/outside/file.txt").then((r) => {
        resolved = true;
        return r;
      });

      // Should not have resolved yet
      await vi.waitFor(() => {
        expect(pio.getPendingPermissions().size).toBe(1);
      });
      expect(resolved).toBe(false);
      expect(mockIO.readFile).not.toHaveBeenCalled();

      // Approve to unblock
      pio.approve("read:/outside/file.txt");
      const result = await promise;
      expect(result).toBe("file content");
      expect(resolved).toBe(true);
    });

    test("blocks on hidden files in cwd (secret)", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      let resolved = false;
      void pio.readFile("/test/cwd/.secret").then(() => {
        resolved = true;
      });

      await vi.waitFor(() => {
        expect(pio.getPendingPermissions().size).toBe(1);
      });
      expect(resolved).toBe(false);
      expect(mockIO.readFile).not.toHaveBeenCalled();
    });
  });

  describe("readFile - secret files with readSecret permission", () => {
    test("allows hidden files when readSecret is granted", async () => {
      const options = {
        ...defaultOptions,
        filePermissions: [
          { path: "/test/cwd", readSecret: true },
        ] as FilePermission[],
      } as unknown as MagentaOptions;
      const pio = createPermissionIO(mockIO, options, onPendingChange);
      const result = await pio.readFile("/test/cwd/.env");
      expect(result).toBe("file content");
    });
  });

  describe("readBinaryFile", () => {
    test("delegates immediately for allowed paths", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      const result = await pio.readBinaryFile("/test/cwd/image.png");
      expect(result).toEqual(Buffer.from("binary"));
      expect(mockIO.readBinaryFile).toHaveBeenCalledWith("/test/cwd/image.png");
    });

    test("blocks on files outside cwd", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      let resolved = false;
      void pio.readBinaryFile("/outside/image.png").then(() => {
        resolved = true;
      });

      await vi.waitFor(() => {
        expect(pio.getPendingPermissions().size).toBe(1);
      });
      expect(resolved).toBe(false);
    });
  });

  describe("writeFile", () => {
    test("delegates immediately for files in cwd", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      await pio.writeFile("/test/cwd/out.txt", "data");
      expect(mockIO.writeFile).toHaveBeenCalledWith(
        "/test/cwd/out.txt",
        "data",
      );
    });

    test("blocks on files outside cwd without permission", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      let resolved = false;
      void pio.writeFile("/outside/out.txt", "data").then(() => {
        resolved = true;
      });

      await vi.waitFor(() => {
        expect(pio.getPendingPermissions().size).toBe(1);
      });
      expect(resolved).toBe(false);
      expect(mockIO.writeFile).not.toHaveBeenCalled();

      pio.approve("write:/outside/out.txt");
      await vi.waitFor(() => {
        expect(resolved).toBe(true);
      });
    });

    test("blocks on hidden files in cwd (secret)", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      let resolved = false;
      void pio.writeFile("/test/cwd/.env", "SECRET=abc").then(() => {
        resolved = true;
      });

      await vi.waitFor(() => {
        expect(pio.getPendingPermissions().size).toBe(1);
      });
      expect(resolved).toBe(false);
    });
  });

  describe("passthrough methods", () => {
    test("fileExists passes through without permission check", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      const result = await pio.fileExists("/anywhere/file.txt");
      expect(result).toBe(true);
      expect(mockIO.fileExists).toHaveBeenCalledWith("/anywhere/file.txt");
      expect(pio.getPendingPermissions().size).toBe(0);
    });

    test("mkdir passes through without permission check", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      await pio.mkdir("/anywhere/dir");
      expect(mockIO.mkdir).toHaveBeenCalledWith("/anywhere/dir");
      expect(pio.getPendingPermissions().size).toBe(0);
    });

    test("stat passes through without permission check", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      const result = await pio.stat("/anywhere/file.txt");
      expect(result).toEqual({ mtimeMs: 1000 });
      expect(mockIO.stat).toHaveBeenCalledWith("/anywhere/file.txt");
      expect(pio.getPendingPermissions().size).toBe(0);
    });
  });

  describe("approve and deny", () => {
    test("approve resolves the blocked promise", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      const promise = pio.readFile("/outside/file.txt");

      await vi.waitFor(() => {
        expect(pio.getPendingPermissions().size).toBe(1);
      });

      pio.approve("read:/outside/file.txt");
      const result = await promise;
      expect(result).toBe("file content");
      expect(pio.getPendingPermissions().size).toBe(0);
    });

    test("deny rejects the blocked promise with error message", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      const promise = pio.readFile("/outside/file.txt");

      await vi.waitFor(() => {
        expect(pio.getPendingPermissions().size).toBe(1);
      });

      pio.deny("read:/outside/file.txt");
      await expect(promise).rejects.toThrow("User denied read access");
      expect(pio.getPendingPermissions().size).toBe(0);
    });
  });

  describe("multiple concurrent requests", () => {
    test("tracks multiple pending permissions correctly", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);

      void pio.readFile("/outside/a.txt");
      void pio.readFile("/outside/b.txt");
      void pio.writeFile("/outside/c.txt", "data");

      await vi.waitFor(() => {
        expect(pio.getPendingPermissions().size).toBe(3);
      });

      const pending = pio.getPendingPermissions();
      expect(pending.has("read:/outside/a.txt")).toBe(true);
      expect(pending.has("read:/outside/b.txt")).toBe(true);
      expect(pending.has("write:/outside/c.txt")).toBe(true);
    });

    test("approveAll resolves all pending promises", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      let resolvedCount = 0;

      void pio.readFile("/outside/a.txt").then(() => resolvedCount++);
      void pio.readFile("/outside/b.txt").then(() => resolvedCount++);

      await vi.waitFor(() => {
        expect(pio.getPendingPermissions().size).toBe(2);
      });

      pio.approveAll();
      await vi.waitFor(() => {
        expect(resolvedCount).toBe(2);
      });
      expect(pio.getPendingPermissions().size).toBe(0);
    });

    test("denyAll rejects all pending promises", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      let rejectedCount = 0;

      void pio.readFile("/outside/a.txt").catch(() => rejectedCount++);
      void pio.writeFile("/outside/b.txt", "d").catch(() => rejectedCount++);

      await vi.waitFor(() => {
        expect(pio.getPendingPermissions().size).toBe(2);
      });

      pio.denyAll();
      await vi.waitFor(() => {
        expect(rejectedCount).toBe(2);
      });
      expect(pio.getPendingPermissions().size).toBe(0);
    });
  });

  describe("getPendingPermissions", () => {
    test("returns correct entries with displayPath and accessType", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      void pio.readFile("/outside/file.txt");

      await vi.waitFor(() => {
        expect(pio.getPendingPermissions().size).toBe(1);
      });

      const entry = pio.getPendingPermissions().get("read:/outside/file.txt");
      expect(entry).toBeDefined();
      expect(entry!.accessType).toBe("read");
      expect(entry!.absFilePath).toBe("/outside/file.txt");
    });
  });

  describe("onPendingChange callback", () => {
    test("called when pending permission is added", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      void pio.readFile("/outside/file.txt");

      await vi.waitFor(() => {
        expect(onPendingChange).toHaveBeenCalled();
      });
    });

    test("called when pending permission is resolved", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      void pio.readFile("/outside/file.txt");

      await vi.waitFor(() => {
        expect(pio.getPendingPermissions().size).toBe(1);
      });

      onPendingChange.mockClear();
      pio.approve("read:/outside/file.txt");
      expect(onPendingChange).toHaveBeenCalled();
    });

    test("called when pending permission is denied", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      void pio.readFile("/outside/file.txt").catch(() => {});

      await vi.waitFor(() => {
        expect(pio.getPendingPermissions().size).toBe(1);
      });

      onPendingChange.mockClear();
      pio.deny("read:/outside/file.txt");
      expect(onPendingChange).toHaveBeenCalled();
    });
  });

  describe("relative path resolution", () => {
    test("resolves relative paths for readFile permission check", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      const result = await pio.readFile("src/file.ts");
      expect(result).toBe("file content");
      expect(mockIO.readFile).toHaveBeenCalledWith("src/file.ts");
      expect(pio.getPendingPermissions().size).toBe(0);
    });

    test("resolves relative paths for readBinaryFile permission check", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      const result = await pio.readBinaryFile("src/image.png");
      expect(result).toEqual(Buffer.from("binary"));
      expect(mockIO.readBinaryFile).toHaveBeenCalledWith("src/image.png");
      expect(pio.getPendingPermissions().size).toBe(0);
    });

    test("resolves relative paths for writeFile permission check", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      await pio.writeFile("src/out.ts", "data");
      expect(mockIO.writeFile).toHaveBeenCalledWith("src/out.ts", "data");
      expect(pio.getPendingPermissions().size).toBe(0);
    });

    test("relative path outside cwd still blocks", async () => {
      const pio = createPermissionIO(mockIO, defaultOptions, onPendingChange);
      let resolved = false;
      void pio.readFile("../../outside/file.txt").then(() => {
        resolved = true;
      });

      await vi.waitFor(() => {
        expect(pio.getPendingPermissions().size).toBe(1);
      });
      expect(resolved).toBe(false);
      expect(mockIO.readFile).not.toHaveBeenCalled();
    });
  });
  describe("tilde expansion in filePermissions", () => {
    test("expands ~ to homeDir in permission paths", async () => {
      const actualHomeDir = os.homedir() as HomeDir;
      const options = {
        ...defaultOptions,
        filePermissions: [
          { path: "~/.config", read: true },
        ] as FilePermission[],
      } as unknown as MagentaOptions;
      const pio = new PermissionCheckingFileIO(
        mockIO,
        { cwd, homeDir: actualHomeDir, options, nvim: mockNvim },
        onPendingChange,
      );
      const result = await pio.readFile(
        `${actualHomeDir}/.config/nvim/init.lua`,
      );
      expect(result).toBe("file content");
    });
  });

  describe("getFileAutoAllowGlobs", () => {
    test("allows file matching glob pattern with real filesystem", async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "magenta-test-"));
      try {
        await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
        await fs.writeFile(path.join(tmpDir, "src", "allowed.ts"), "content");

        const options = {
          ...defaultOptions,
          getFileAutoAllowGlobs: ["src/**/*.ts"],
        } as unknown as MagentaOptions;

        const pio = new PermissionCheckingFileIO(
          mockIO,
          {
            cwd: tmpDir as NvimCwd,
            homeDir,
            options,
            nvim: mockNvim,
          },
          onPendingChange,
        );

        const result = await pio.readFile(
          path.join(tmpDir, "src", "allowed.ts"),
        );
        expect(result).toBe("file content");
      } finally {
        await fs.rm(tmpDir, { recursive: true });
      }
    });
  });
});
