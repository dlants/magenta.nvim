import type {
  LspClient,
  LspHoverResponse,
  LspReferencesResponse,
  LspDefinitionResponse,
} from "@magenta/core";
import type { Lsp } from "./lsp.ts";
import type { Nvim } from "../nvim/nvim-node/index.ts";
import type {
  AbsFilePath,
  HomeDir,
  NvimCwd,
  UnresolvedFilePath,
} from "../utils/files.ts";
import { getOrOpenBuffer } from "../utils/buffers.ts";
import type { Row0Indexed, StringIdx } from "../nvim/window.ts";

export class NvimLspClient implements LspClient {
  constructor(
    private lsp: Lsp,
    private nvim: Nvim,
    private cwd: NvimCwd,
    private homeDir: HomeDir,
  ) {}

  async requestHover(
    filePath: AbsFilePath,
    position: { line: number; character: number },
  ): Promise<LspHoverResponse> {
    const buffer = await this.getBuffer(filePath);
    return this.lsp.requestHover(buffer, {
      row: position.line as Row0Indexed,
      col: position.character as StringIdx,
    });
  }

  async requestReferences(
    filePath: AbsFilePath,
    position: { line: number; character: number },
  ): Promise<LspReferencesResponse> {
    const buffer = await this.getBuffer(filePath);
    return this.lsp.requestReferences(buffer, {
      row: position.line as Row0Indexed,
      col: position.character as StringIdx,
    });
  }

  async requestDefinition(
    filePath: AbsFilePath,
    position: { line: number; character: number },
  ): Promise<LspDefinitionResponse> {
    const buffer = await this.getBuffer(filePath);
    return this.lsp.requestDefinition(buffer, {
      row: position.line as Row0Indexed,
      col: position.character as StringIdx,
    });
  }

  async requestTypeDefinition(
    filePath: AbsFilePath,
    position: { line: number; character: number },
  ): Promise<LspDefinitionResponse> {
    const buffer = await this.getBuffer(filePath);
    return this.lsp.requestTypeDefinition(buffer, {
      row: position.line as Row0Indexed,
      col: position.character as StringIdx,
    });
  }

  private async getBuffer(filePath: AbsFilePath) {
    const result = await getOrOpenBuffer({
      unresolvedPath: filePath as string as UnresolvedFilePath,
      context: {
        nvim: this.nvim,
        cwd: this.cwd,
        homeDir: this.homeDir,
      },
    });

    if (result.status !== "ok") {
      throw new Error(`Failed to open buffer for ${filePath}: ${result.error}`);
    }

    return result.buffer;
  }
}
