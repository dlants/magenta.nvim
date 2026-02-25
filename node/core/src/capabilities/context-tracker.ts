import type { AbsFilePath, FileTypeInfo } from "../utils/files.ts";

export interface TrackedFileInfo {
  agentView:
    | { type: "text"; content: string }
    | { type: "binary" }
    | {
        type: "pdf";
        summary: boolean;
        pages: number[];
        supportsPageExtraction: boolean;
      }
    | undefined;
}

export type ToolApplied =
  | {
      type: "get-file";
      content: string;
    }
  | {
      type: "get-file-pdf";
      content: { type: "summary" } | { type: "page"; pdfPage: number };
    }
  | {
      type: "get-file-binary";
      mtime: number;
    }
  | {
      type: "edl-edit";
      content: string;
    };

export type OnToolApplied = (
  absFilePath: AbsFilePath,
  tool: ToolApplied,
  fileTypeInfo: FileTypeInfo,
) => void;

export interface ContextTracker {
  files: { [filePath: AbsFilePath]: TrackedFileInfo | undefined };
}
