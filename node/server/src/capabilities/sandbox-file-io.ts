import {
  containsGlobChars,
  globToRegex,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import type { Logger } from "../logger.ts";
import type { Sandbox } from "../sandbox-manager.ts";
import {
  type AbsFilePath,
  type HomeDir,
  type ProjectDir,
  resolveFilePath,
  type UnresolvedFilePath,
} from "../utils/files.ts";
import { type FileIO, FsFileIO } from "./file-io.ts";

export class SandboxFileIO implements FileIO {
  constructor(
    private context: {
      logger: Logger;
      projectDir: ProjectDir;
      homeDir: HomeDir;
    },
    private sandbox: Sandbox,
    private promptForWriteApproval: (absPath: AbsFilePath) => Promise<void>,
    private isBypassed: () => boolean,
    /** Lets an attached editor refresh its view of a file the agent wrote. */
    private onFileWritten?: (absPath: AbsFilePath) => Promise<void>,
    /** The unsandboxed storage the checks gate; the host filesystem in production. */
    private inner: FileIO = new FsFileIO(),
  ) {}

  private resolvePath(path: string): AbsFilePath {
    return resolveFilePath(
      this.context.projectDir,
      path as UnresolvedFilePath,
      this.context.homeDir,
    );
  }

  /** Replicate the seatbelt matching logic from sandbox-runtime:
   *  - literal paths use subpath matching (path + all children)
   *  - glob patterns use regex matching via globToRegex
   */
  private pathMatchesPattern(absPath: string, pattern: string): boolean {
    if (containsGlobChars(pattern)) {
      return new RegExp(globToRegex(pattern)).test(absPath);
    }
    if (pattern === "/") {
      return absPath.startsWith("/");
    }
    return absPath === pattern || absPath.startsWith(`${pattern}/`);
  }

  isReadBlocked(absPath: string): boolean {
    if (this.sandbox.getState().status !== "ready") return false;
    const readConfig = this.sandbox.getFsReadConfig();
    const isDenied = readConfig.denyOnly.some((pattern) =>
      this.pathMatchesPattern(absPath, pattern),
    );
    if (!isDenied) return false;
    const isReAllowed = (readConfig.allowWithinDeny ?? []).some((pattern) =>
      this.pathMatchesPattern(absPath, pattern),
    );
    return !isReAllowed;
  }

  async readFile(path: string): Promise<string> {
    const abs = this.resolvePath(path);
    if (this.isReadBlocked(abs)) {
      throw new Error(`Sandbox: read access denied for ${path}`);
    }

    return this.inner.readFile(abs);
  }

  async readBinaryFile(path: string): Promise<Buffer> {
    const abs = this.resolvePath(path);
    if (this.isReadBlocked(abs)) {
      throw new Error(`Sandbox: read access denied for ${path}`);
    }
    return this.inner.readBinaryFile(abs);
  }

  isWriteBlocked(absPath: string): boolean {
    if (this.isBypassed()) return false;
    if (this.sandbox.getState().status !== "ready") return true;
    const writeConfig = this.sandbox.getFsWriteConfig();
    const inAllowed = writeConfig.allowOnly.some((pattern) =>
      this.pathMatchesPattern(absPath, pattern),
    );
    if (!inAllowed) return true;
    const inDeny = writeConfig.denyWithinAllow.some((pattern) =>
      this.pathMatchesPattern(absPath, pattern),
    );
    return inDeny;
  }

  async writeFile(path: string, content: string): Promise<void> {
    const abs = this.resolvePath(path);
    if (this.isWriteBlocked(abs)) {
      await this.promptForWriteApproval(abs);
    }

    await this.inner.writeFile(abs, content);

    this.onFileWritten?.(abs).catch((err) => {
      this.context.logger.warn(
        `Failed to refresh editor for ${abs}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
  async fileExists(path: string): Promise<boolean> {
    return this.inner.fileExists(this.resolvePath(path));
  }

  async mkdir(path: string): Promise<void> {
    await this.inner.mkdir(this.resolvePath(path));
  }

  async stat(
    path: string,
  ): Promise<{ mtimeMs: number; size: number } | undefined> {
    return this.inner.stat(this.resolvePath(path));
  }

  async readdir(path: string): Promise<string[]> {
    return this.inner.readdir(this.resolvePath(path));
  }

  async isDirectory(path: string): Promise<boolean> {
    return this.inner.isDirectory(this.resolvePath(path));
  }
}
