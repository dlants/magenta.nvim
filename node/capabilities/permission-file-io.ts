import type { FileIO } from "./file-io.ts";
import { canReadFile, canWriteFile } from "./permissions.ts";
import {
  displayPath,
  resolveFilePath,
  type AbsFilePath,
  type HomeDir,
  type NvimCwd,
} from "../utils/files.ts";
import type { MagentaOptions } from "../options.ts";
import type { Nvim } from "../nvim/nvim-node";
import { d, withBindings, withExtmark, type VDOMNode } from "../tea/view.ts";

export type AccessType = "read" | "write";

export type PendingPermission = {
  absFilePath: AbsFilePath;
  accessType: AccessType;
  displayPath: string;
  resolve: () => void;
  reject: (err: Error) => void;
};

export class PermissionCheckingFileIO implements FileIO {
  private pending: Map<string, PendingPermission> = new Map();

  constructor(
    private inner: FileIO,
    private permissionContext: {
      cwd: NvimCwd;
      homeDir: HomeDir;
      options: MagentaOptions;
      nvim: Nvim;
    },
    private onPendingChange: () => void,
  ) {}

  private resolvePath(path: string): AbsFilePath {
    return resolveFilePath(
      this.permissionContext.cwd,
      path as Parameters<typeof resolveFilePath>[1],
      this.permissionContext.homeDir,
    );
  }

  private pendingKey(absFilePath: AbsFilePath, accessType: AccessType): string {
    return `${accessType}:${absFilePath}`;
  }

  private async checkReadPermission(absFilePath: AbsFilePath): Promise<void> {
    const allowed = await canReadFile(absFilePath, this.permissionContext);
    if (allowed) return;

    return new Promise<void>((resolve, reject) => {
      const key = this.pendingKey(absFilePath, "read");
      this.pending.set(key, {
        absFilePath,
        accessType: "read",
        displayPath: displayPath(
          this.permissionContext.cwd,
          absFilePath,
          this.permissionContext.homeDir,
        ),
        resolve,
        reject,
      });
      this.onPendingChange();
    });
  }

  private checkWritePermission(absFilePath: AbsFilePath): Promise<void> {
    const allowed = canWriteFile(absFilePath, this.permissionContext);
    if (allowed) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const key = this.pendingKey(absFilePath, "write");
      this.pending.set(key, {
        absFilePath,
        accessType: "write",
        displayPath: displayPath(
          this.permissionContext.cwd,
          absFilePath,
          this.permissionContext.homeDir,
        ),
        resolve,
        reject,
      });
      this.onPendingChange();
    });
  }

  async readFile(path: string): Promise<string> {
    await this.checkReadPermission(this.resolvePath(path));
    return this.inner.readFile(path);
  }

  async readBinaryFile(path: string): Promise<Buffer> {
    await this.checkReadPermission(this.resolvePath(path));
    return this.inner.readBinaryFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.checkWritePermission(this.resolvePath(path));
    return this.inner.writeFile(path, content);
  }

  async fileExists(path: string): Promise<boolean> {
    return this.inner.fileExists(path);
  }

  async mkdir(path: string): Promise<void> {
    return this.inner.mkdir(path);
  }

  async stat(path: string): Promise<{ mtimeMs: number } | undefined> {
    return this.inner.stat(path);
  }

  approve(key: string): void {
    const entry = this.pending.get(key);
    if (entry) {
      this.pending.delete(key);
      entry.resolve();
      this.onPendingChange();
    }
  }

  deny(key: string): void {
    const entry = this.pending.get(key);
    if (entry) {
      this.pending.delete(key);
      entry.reject(
        new Error(
          `User denied ${entry.accessType} access to ${entry.displayPath}`,
        ),
      );
      this.onPendingChange();
    }
  }

  approveAll(): void {
    for (const [key, entry] of this.pending) {
      this.pending.delete(key);
      entry.resolve();
    }
    this.onPendingChange();
  }

  denyAll(): void {
    for (const [key, entry] of this.pending) {
      this.pending.delete(key);
      entry.reject(
        new Error(
          `User denied ${entry.accessType} access to ${entry.displayPath}`,
        ),
      );
    }
    this.onPendingChange();
  }

  getPendingPermissions(): Map<string, PendingPermission> {
    return this.pending;
  }

  view(): VDOMNode {
    if (this.pending.size === 0) {
      return d``;
    }

    const entries = [...this.pending.entries()];

    return d`
${entries.map(
  ([key, entry]) =>
    d`${entry.accessType === "read" ? "👀" : "✏️"} ${entry.displayPath}
${withBindings(
  withExtmark(d`> NO`, {
    hl_group: ["ErrorMsg", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => this.deny(key),
  },
)}
${withBindings(
  withExtmark(d`> YES`, {
    hl_group: ["String", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => this.approve(key),
  },
)}
`,
)}${
      entries.length > 1
        ? d`${withBindings(
            withExtmark(d`> DENY ALL`, {
              hl_group: ["ErrorMsg", "@markup.strong.markdown"],
            }),
            {
              "<CR>": () => this.denyAll(),
            },
          )}
${withBindings(
  withExtmark(d`> APPROVE ALL`, {
    hl_group: ["String", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => this.approveAll(),
  },
)}
`
        : d``
    }`;
  }
}
