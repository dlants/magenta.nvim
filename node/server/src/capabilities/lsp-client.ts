import type { AbsFilePath } from "../utils/files.ts";

type LspPosition = {
  line: number;
  character: number;
};

export type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

export type LspHoverResponse = (null | {
  result: {
    range: LspRange;
    contents: {
      kind: string;
      value: string;
    };
  };
})[];

export type LspReferencesResponse = (null | {
  result: {
    uri: string;
    range: LspRange;
  }[];
})[];

export type LspDefinitionResponse = (null | {
  result: (
    | {
        uri: string;
        range: LspRange;
      }
    | {
        targetUri: string;
        targetRange: LspRange;
        targetSelectionRange?: LspRange;
        originSelectionRange?: LspRange;
      }
  )[];
})[];

export interface LspClient {
  requestHover(
    filePath: AbsFilePath,
    position: { line: number; character: number },
  ): Promise<LspHoverResponse>;

  requestReferences(
    filePath: AbsFilePath,
    position: { line: number; character: number },
  ): Promise<LspReferencesResponse>;

  requestDefinition(
    filePath: AbsFilePath,
    position: { line: number; character: number },
  ): Promise<LspDefinitionResponse>;

  requestTypeDefinition(
    filePath: AbsFilePath,
    position: { line: number; character: number },
  ): Promise<LspDefinitionResponse>;
}
