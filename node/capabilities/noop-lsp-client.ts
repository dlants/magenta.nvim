import type {
  LspClient,
  LspHoverResponse,
  LspReferencesResponse,
  LspDefinitionResponse,
} from "@magenta/core";
import type { AbsFilePath } from "@magenta/core";

export class NoopLspClient implements LspClient {
  requestHover(
    _filePath: AbsFilePath,
    _position: { line: number; character: number },
  ): Promise<LspHoverResponse> {
    return Promise.resolve([]);
  }

  requestReferences(
    _filePath: AbsFilePath,
    _position: { line: number; character: number },
  ): Promise<LspReferencesResponse> {
    return Promise.resolve([]);
  }

  requestDefinition(
    _filePath: AbsFilePath,
    _position: { line: number; character: number },
  ): Promise<LspDefinitionResponse> {
    return Promise.resolve([]);
  }

  requestTypeDefinition(
    _filePath: AbsFilePath,
    _position: { line: number; character: number },
  ): Promise<LspDefinitionResponse> {
    return Promise.resolve([]);
  }
}
