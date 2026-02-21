import type { Shell, ShellResult, OutputLine } from "./shell.ts";
import {
  isCommandAllowedByConfig,
  type PermissionCheckResult,
} from "./bash-parser/permissions.ts";
import type { MagentaOptions } from "../options.ts";
import type { NvimCwd, HomeDir } from "../utils/files.ts";
import type { Nvim } from "../nvim/nvim-node";
import { d, withBindings, withExtmark, withInlineCode } from "../tea/view.ts";
import type { VDOMNode } from "../tea/view.ts";

export type PendingCommand = {
  command: string;
  opts: { toolRequestId: string };
  resolve: (result: ShellResult) => void;
  reject: (err: Error) => void;
};

export class PermissionCheckingShell implements Shell {
  private pending: Map<string, PendingCommand> = new Map();
  private nextId = 0;

  constructor(
    private inner: Shell,
    private permissionContext: {
      cwd: NvimCwd;
      homeDir: HomeDir;
      options: MagentaOptions;
      nvim: Nvim;
      rememberedCommands: Set<string>;
    },
    private onPendingChange: () => void,
  ) {}

  private checkPermissions(command: string): PermissionCheckResult {
    if (this.permissionContext.rememberedCommands.has(command)) {
      return { allowed: true };
    }

    return isCommandAllowedByConfig(
      command,
      this.permissionContext.options.commandConfig,
      {
        cwd: this.permissionContext.cwd,
        homeDir: this.permissionContext.homeDir,
        skillsPaths: this.permissionContext.options.skillsPaths,
        filePermissions: this.permissionContext.options.filePermissions,
      },
    );
  }

  async execute(
    command: string,
    opts: {
      toolRequestId: string;
      onOutput?: (line: OutputLine) => void;
    },
  ): Promise<ShellResult> {
    const permissionResult = this.checkPermissions(command);

    if (permissionResult.allowed) {
      return this.inner.execute(command, opts);
    }

    // Block until user approves or denies
    return new Promise<ShellResult>((resolve, reject) => {
      const id = String(this.nextId++);
      this.pending.set(id, { command, opts, resolve, reject });
      this.onPendingChange();
    });
  }

  approve(id: string, remember?: boolean): void {
    const entry = this.pending.get(id);
    if (!entry) return;

    this.pending.delete(id);

    if (remember) {
      this.permissionContext.rememberedCommands.add(entry.command);
    }

    // Execute the command and pipe the result back to the waiting promise
    this.inner
      .execute(entry.command, entry.opts)
      .then(entry.resolve)
      .catch(entry.reject);

    this.onPendingChange();
  }

  deny(id: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;

    this.pending.delete(id);
    entry.reject(new Error("The user did not allow running this command."));
    this.onPendingChange();
  }

  approveAll(): void {
    for (const [id] of this.pending) {
      this.approve(id);
    }
  }

  denyAll(): void {
    for (const [id] of this.pending) {
      this.deny(id);
    }
  }

  terminate(): void {
    this.inner.terminate();
  }
  getPendingPermissions(): Map<string, PendingCommand> {
    return this.pending;
  }

  view(): VDOMNode {
    if (this.pending.size === 0) {
      return d``;
    }

    const entries = [...this.pending.entries()];

    return d`
${entries.map(
  ([id, entry]) =>
    d`⚡ May I run command ${withInlineCode(d`\`${entry.command}\``)}?
${withBindings(
  withExtmark(d`> NO`, {
    hl_group: ["ErrorMsg", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => this.deny(id),
  },
)}
${withBindings(
  withExtmark(d`> YES`, {
    hl_group: ["String", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => this.approve(id),
  },
)}
${withBindings(
  withExtmark(d`> ALWAYS`, {
    hl_group: ["WarningMsg", "@markup.strong.markdown"],
  }),
  {
    "<CR>": () => this.approve(id, true),
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
