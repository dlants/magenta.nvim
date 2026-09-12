import type { NativeMessageIdx } from "../providers/provider-types.ts";
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
    | { type: "summary" }
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
      previousContent: string;
    };

export type OnToolApplied = (
  absFilePath: AbsFilePath,
  tool: ToolApplied,
  fileTypeInfo: FileTypeInfo,
) => void;

/** The observer-facing form. Tools call `OnToolApplied` and never learn about
 * message indices; `ThreadCore` adds the idx of the message that will hold the
 * tool result before forwarding to supervisors, which key their view history
 * on it. */
export type ToolAppliedEvent = {
  absFilePath: AbsFilePath;
  tool: ToolApplied;
  fileTypeInfo: FileTypeInfo;
  nativeMessageIdx: NativeMessageIdx;
};
/** An object parameter rather than a fourth positional argument, so that an
 * `OnToolApplied` cannot be passed where an `OnToolAppliedHook` is wanted:
 * TypeScript accepts a function that ignores trailing parameters, which would
 * silently drop the idx. */
export type OnToolAppliedHook = (event: ToolAppliedEvent) => void;

export interface ContextTracker {
  files: { [filePath: AbsFilePath]: TrackedFileInfo | undefined };
}
