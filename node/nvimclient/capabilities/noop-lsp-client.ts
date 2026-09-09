import type {
  AbsFilePath,
  LspClient,
  LspDefinitionResponse,
  LspHoverResponse,
  LspReferencesResponse,
} from "@magenta/server";

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
