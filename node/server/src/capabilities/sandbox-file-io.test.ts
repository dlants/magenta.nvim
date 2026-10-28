import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
  FsReadConfig,
  FsWriteConfig,
  Sandbox,
  SandboxState,
} from "../sandbox-manager.ts";
import { noopLogger } from "../test-helpers.ts";
import type { AbsFilePath, HomeDir, ProjectDir } from "../utils/files.ts";
import { SandboxFileIO } from "./sandbox-file-io.ts";

let currentSandboxState: SandboxState = { status: "uninitialized" };
let mockFsReadConfig: FsReadConfig = { denyOnly: [] };
let mockFsWriteConfig: FsWriteConfig = {
  allowOnly: ["/"],
  denyWithinAllow: [],
};

function createMockSandbox(): Sandbox {
  return {
    getState: () => currentSandboxState,
    getFsReadConfig: () => mockFsReadConfig,
    getFsWriteConfig: () => mockFsWriteConfig,
    wrapWithSandbox: (cmd: string) => Promise.resolve(cmd),
    getViolationStore: () => ({
      getTotalCount: () => 0,
      getViolations: () => [],
      addViolation: () => {},
    }),
    annotateStderrWithSandboxFailures: (_cmd: string, stderr: string) => stderr,
    updateConfigIfChanged: () => {},
    cleanupAfterCommand: () => {},
    pushNetworkAskTarget: () => {},
    popNetworkAskTarget: () => {},
    routeNetworkAsk: () => Promise.resolve(false),
    recordSessionApprovedHost: () => {},
  };
}

const projectDir = "/test/projectDir" as ProjectDir;
const homeDir = "/test/home" as HomeDir;

function createSandboxIO(
  promptForWriteApproval: (absPath: string) => Promise<void> = vi.fn(),
  isBypassed: () => boolean = () => false,
) {
  return new SandboxFileIO(
    { logger: noopLogger, projectDir, homeDir },
    createMockSandbox(),
    promptForWriteApproval,
    isBypassed,
  );
}

describe("SandboxFileIO", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("when sandbox is ready", () => {
    beforeEach(() => {
      currentSandboxState = { status: "ready" };
    });

    describe("reads", () => {
      test("allowed path is not blocked", () => {
        mockFsReadConfig = {
          denyOnly: ["/test/home/.ssh"],
        };

        const sio = createSandboxIO();
        expect(sio.isReadBlocked("/test/projectDir/src/file.ts")).toBe(false);
      });

      test("denied path is blocked", () => {
        mockFsReadConfig = {
          denyOnly: ["/test/home/.ssh"],
        };

        const sio = createSandboxIO();
        expect(sio.isReadBlocked("/test/home/.ssh/id_rsa")).toBe(true);
      });

      test("deny exact path match", () => {
        mockFsReadConfig = {
          denyOnly: ["/test/home/.ssh"],
        };

        const sio = createSandboxIO();
        expect(sio.isReadBlocked("/test/home/.ssh")).toBe(true);
      });

      test("deny prefix does not match non-child paths", () => {
        mockFsReadConfig = {
          denyOnly: ["/test/home/.ssh"],
        };

        const sio = createSandboxIO();
        expect(sio.isReadBlocked("/test/home/.sshrc")).toBe(false);
      });

      test("readBinaryFile denied path throws", async () => {
        mockFsReadConfig = {
          denyOnly: ["/test/home/.aws"],
        };

        const sio = createSandboxIO();
        await expect(
          sio.readBinaryFile("/test/home/.aws/credentials"),
        ).rejects.toThrow("Sandbox: read access denied");
      });

      test("allowWithinDeny re-allows denied paths", () => {
        mockFsReadConfig = {
          denyOnly: ["/test/home/.config"],
          allowWithinDeny: ["/test/home/.config/nvim"],
        };

        const sio = createSandboxIO();
        expect(sio.isReadBlocked("/test/home/.config/nvim/init.lua")).toBe(
          false,
        );
      });

      test("allowWithinDeny does not re-allow sibling paths", () => {
        mockFsReadConfig = {
          denyOnly: ["/test/home/.config"],
          allowWithinDeny: ["/test/home/.config/nvim"],
        };

        const sio = createSandboxIO();
        expect(sio.isReadBlocked("/test/home/.config/secrets/key")).toBe(true);
      });
    });

    describe("writes", () => {
      test("write to allowed path is not blocked", () => {
        mockFsWriteConfig = {
          allowOnly: ["/test/projectDir"],
          denyWithinAllow: [],
        };

        const sio = createSandboxIO();
        expect(sio.isWriteBlocked("/test/projectDir/src/file.ts")).toBe(false);
      });

      test("write outside allowOnly is blocked", () => {
        mockFsWriteConfig = {
          allowOnly: ["/test/projectDir"],
          denyWithinAllow: [],
        };

        const sio = createSandboxIO();
        expect(sio.isWriteBlocked("/outside/file.txt")).toBe(true);
      });

      test("write to denyWithinAllow is blocked", () => {
        mockFsWriteConfig = {
          allowOnly: ["/test/projectDir"],
          denyWithinAllow: ["/test/projectDir/.env"],
        };

        const sio = createSandboxIO();
        expect(sio.isWriteBlocked("/test/projectDir/.env")).toBe(true);
      });

      test("write blocked path prompts for approval", async () => {
        mockFsWriteConfig = {
          allowOnly: ["/test/projectDir"],
          denyWithinAllow: [],
        };

        const prompt = vi
          .fn()
          .mockRejectedValue(new Error("User denied write"));
        const sio = createSandboxIO(prompt);
        await expect(
          sio.writeFile("/outside/file.txt", "data"),
        ).rejects.toThrow("User denied write");
        expect(prompt).toHaveBeenCalledWith("/outside/file.txt");
      });

      test("write denyWithinAllow prefix does not match non-child", () => {
        mockFsWriteConfig = {
          allowOnly: ["/test/projectDir"],
          denyWithinAllow: ["/test/projectDir/.env"],
        };

        const sio = createSandboxIO();
        expect(sio.isWriteBlocked("/test/projectDir/.environment")).toBe(false);
      });
    });
  });

  describe("when sandbox is not ready", () => {
    test("reads are not blocked when unsupported", () => {
      currentSandboxState = { status: "unsupported", reason: "disabled" };
      const sio = createSandboxIO();
      expect(sio.isReadBlocked("/anywhere/file.txt")).toBe(false);
    });

    test("reads are not blocked when uninitialized", () => {
      currentSandboxState = { status: "uninitialized" };
      const sio = createSandboxIO();
      expect(sio.isReadBlocked("/anywhere/file.txt")).toBe(false);
    });

    test("writes are blocked when unsupported", () => {
      currentSandboxState = { status: "unsupported", reason: "disabled" };
      const sio = createSandboxIO();
      expect(sio.isWriteBlocked("/test/projectDir/file.ts")).toBe(true);
    });

    test("writes are blocked when uninitialized", () => {
      currentSandboxState = { status: "uninitialized" };
      const sio = createSandboxIO();
      expect(sio.isWriteBlocked("/test/projectDir/file.ts")).toBe(true);
    });

    test("writes are not blocked when bypassed", () => {
      currentSandboxState = { status: "uninitialized" };
      const sio = createSandboxIO(vi.fn(), () => true);
      expect(sio.isWriteBlocked("/test/projectDir/file.ts")).toBe(false);
    });
  });

  describe("glob deny patterns", () => {
    beforeEach(() => {
      currentSandboxState = { status: "ready" };
    });

    describe("dir/.* pattern", () => {
      test("blocks hidden file directly in dir", () => {
        mockFsReadConfig = { denyOnly: ["/test/home/.*"] };
        const sio = createSandboxIO();
        expect(sio.isReadBlocked("/test/home/.hiddenfile")).toBe(true);
      });

      test("does not block children of glob-matched dir (matches seatbelt regex behavior)", () => {
        mockFsReadConfig = { denyOnly: ["/test/home/.*"] };
        const sio = createSandboxIO();
        // globToRegex(".*") produces [^/]* which doesn't match paths with /
        expect(sio.isReadBlocked("/test/home/.hiddendir/file")).toBe(false);
      });

      test("allows non-hidden file in same dir", () => {
        mockFsReadConfig = { denyOnly: ["/test/home/.*"] };
        const sio = createSandboxIO();
        expect(sio.isReadBlocked("/test/home/visible_file")).toBe(false);
      });
    });

    describe("dir/**/.* pattern", () => {
      test("blocks hidden file in subdirectory", () => {
        mockFsReadConfig = { denyOnly: ["/test/home/**/.*"] };
        const sio = createSandboxIO();
        expect(sio.isReadBlocked("/test/home/subdir/.hiddenfile")).toBe(true);
      });

      test("blocks hidden file directly in home (** matches zero dirs)", () => {
        mockFsReadConfig = { denyOnly: ["/test/home/**/.*"] };
        const sio = createSandboxIO();
        expect(sio.isReadBlocked("/test/home/.bashrc")).toBe(true);
      });

      test("allows non-hidden file in subdirectory", () => {
        mockFsReadConfig = { denyOnly: ["/test/home/**/.*"] };
        const sio = createSandboxIO();
        expect(sio.isReadBlocked("/test/home/subdir/visible_file")).toBe(false);
      });
    });

    describe("combined default deny patterns", () => {
      test("both patterns together block hidden files at any depth", () => {
        mockFsReadConfig = {
          denyOnly: ["/test/home/.*", "/test/home/**/.*"],
        };
        const sio = createSandboxIO();

        // Direct hidden file
        expect(sio.isReadBlocked("/test/home/.ssh")).toBe(true);
        // Hidden file in subdirectory
        expect(sio.isReadBlocked("/test/home/subdir/.env")).toBe(true);
        // Non-hidden file is allowed
        expect(sio.isReadBlocked("/test/home/visible")).toBe(false);
      });
    });
  });

  describe("path resolution", () => {
    test("resolves relative paths before checking", () => {
      currentSandboxState = { status: "ready" };
      mockFsReadConfig = { denyOnly: ["/test/home/.ssh"] };
      const sio = createSandboxIO();
      // "src/file.ts" resolves to "/test/projectDir/src/file.ts" — not denied
      expect(sio.isReadBlocked("/test/projectDir/src/file.ts")).toBe(false);
    });

    test("resolves tilde paths before checking", async () => {
      currentSandboxState = { status: "ready" };
      mockFsReadConfig = { denyOnly: ["/test/home/.ssh"] };
      const sio = createSandboxIO();
      // "~/.ssh/id_rsa" resolves to "/test/home/.ssh/id_rsa" — denied
      await expect(sio.readFile("~/.ssh/id_rsa")).rejects.toThrow(
        "Sandbox: read access denied",
      );
    });
  });
});

describe("SandboxFileIO onFileWritten", () => {
  async function setup(
    onFileWritten: (absPath: AbsFilePath) => Promise<void>,
    prompt: (absPath: string) => Promise<void> = vi.fn(),
  ) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-fio-"));
    currentSandboxState = { status: "ready" };
    mockFsWriteConfig = { allowOnly: [dir], denyWithinAllow: [] };
    const sio = new SandboxFileIO(
      { logger: noopLogger, projectDir: dir as ProjectDir, homeDir },
      createMockSandbox(),
      prompt,
      () => false,
      onFileWritten,
    );
    return { dir, sio };
  }

  test("is called with the resolved absolute path after a write", async () => {
    const onFileWritten = vi.fn(() => Promise.resolve());
    const { dir, sio } = await setup(onFileWritten);
    await sio.writeFile("a.txt", "hi");
    expect(onFileWritten).toHaveBeenCalledWith(path.join(dir, "a.txt"));
  });

  test("is not called when write approval is rejected", async () => {
    const onFileWritten = vi.fn(() => Promise.resolve());
    const { sio } = await setup(onFileWritten, () =>
      Promise.reject(new Error("denied")),
    );
    await expect(sio.writeFile("/outside/x.txt", "hi")).rejects.toThrow(
      "denied",
    );
    expect(onFileWritten).not.toHaveBeenCalled();
  });

  test("a rejecting callback does not fail the write", async () => {
    const { dir, sio } = await setup(() => Promise.reject(new Error("boom")));
    await sio.writeFile("b.txt", "ok");
    expect(await fs.readFile(path.join(dir, "b.txt"), "utf-8")).toBe("ok");
  });
});
