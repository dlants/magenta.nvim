import type {
  LspClient,
  LspHoverResponse,
  LspReferencesResponse,
  LspDefinitionResponse,
} from "@magenta/core";
import type { AbsFilePath } from "@magenta/core";

export class NoopLspClient implements LspClient {
  async requestHover(
    _filePath: AbsFilePath,
    _position: { line: number; character: number },
  ): Promise<LspHoverResponse> {
    return [];
  }

  async requestReferences(
    _filePath: AbsFilePath,
    _position: { line: number; character: number },
  ): Promise<LspReferencesResponse> {
    return [];
  }

  async requestDefinition(
    _filePath: AbsFilePath,
    _position: { line: number; character: number },
  ): Promise<LspDefinitionResponse> {
    return [];
  }

  async requestTypeDefinition(
    _filePath: AbsFilePath,
    _position: { line: number; character: number },
  ): Promise<LspDefinitionResponse> {
    return [];
  }
}
