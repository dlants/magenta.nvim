import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fileTypeFromFile } from "file-type";
import { lookup } from "mime-types";

export type AbsFilePath = string & { __abs_file_path: true };
export type RelFilePath = string & { __rel_file_path: true };
export type UnresolvedFilePath = string & { __unresolved_file_path: true };
export type HomeDir = AbsFilePath & { __home_dir: true };
export type DisplayPath = string & { __display_path: true };

export const MAGENTA_TEMP_DIR = "/tmp/magenta" as AbsFilePath;

/** Special nominal type to represent the neovim directory. The node plugin runs in the magenta directory, but when
 * dealing with paths, we always want to do it from the POV of the nvim cwd.
 */
export type NvimCwd = AbsFilePath & { __nvim_cwd: true };

export const FileCategory = {
  TEXT: "text",
  IMAGE: "image",
  PDF: "pdf",
  UNSUPPORTED: "unsupported",
} as const;
export type FileCategory = (typeof FileCategory)[keyof typeof FileCategory];

export interface FileTypeInfo {
  category: FileCategory;
  mimeType: string;
  extension: string;
}

export function expandTilde(filepath: string, homeDir: HomeDir): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    return path.join(homeDir, filepath.slice(1));
  }
  return filepath;
}

export function resolveFilePath(
  cwd: NvimCwd,
  filePath: UnresolvedFilePath | AbsFilePath | RelFilePath,
  homeDir: HomeDir,
) {
  let expandedPath = filePath as string;
  if (expandedPath.startsWith("~/") || expandedPath === "~") {
    expandedPath = path.join(homeDir, expandedPath.slice(1));
  }
  return path.resolve(cwd, expandedPath) as AbsFilePath;
}

export function relativePath(
  cwd: NvimCwd,
  filePath: UnresolvedFilePath | AbsFilePath,
  homeDir: HomeDir,
) {
  const absPath = resolveFilePath(cwd, filePath, homeDir);
  return path.relative(cwd, absPath) as RelFilePath;
}

export function displayPath(
  cwd: NvimCwd,
  absFilePath: AbsFilePath,
  homeDir: HomeDir,
): DisplayPath {
  const rel = path.relative(cwd, absFilePath);
  if (!rel.startsWith("..")) {
    return rel as DisplayPath;
  }
  if (absFilePath.startsWith(homeDir)) {
    return ("~" + absFilePath.slice(homeDir.length)) as DisplayPath;
  }
  return absFilePath as string as DisplayPath;
}
// File size limits in bytes
export const FILE_SIZE_LIMITS = {
  IMAGE: 10 * 1024 * 1024, // 10MB
  PDF: 32 * 1024 * 1024, // 32MB
} as const;

export function categorizeFileType(mimeType: string): FileCategory {
  // Text files
  if (mimeType.startsWith("text/")) {
    return FileCategory.TEXT;
  }

  // Common text-based formats that don't have text/ mime type
  const textMimeTypes = [
    "application/javascript",
    "application/json",
    "application/xml",
    "application/x-yaml",
    "application/yaml",
    "application/toml",
    "application/x-sh",
    "application/x-shellscript",
  ];

  if (textMimeTypes.includes(mimeType)) {
    return FileCategory.TEXT;
  }

  // Images supported by Anthropic
  const imageMimeTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];

  if (imageMimeTypes.includes(mimeType)) {
    return FileCategory.IMAGE;
  }

  // PDF documents
  if (mimeType === "application/pdf") {
    return FileCategory.PDF;
  }

  return FileCategory.UNSUPPORTED;
}

export async function isLikelyTextFile(filePath: string): Promise<boolean> {
  // Check file extension patterns as fallback
  const ext = path.extname(filePath).toLowerCase();
  const textExtensions = [
    ".adoc",
    ".bash",
    ".bat",
    ".c",
    ".cfg",
    ".cmd",
    ".conf",
    ".cpp",
    ".cs",
    ".css",
    ".dockerfile",
    ".editorconfig",
    ".fish",
    ".gitattributes",
    ".gitignore",
    ".go",
    ".h",
    ".hpp",
    ".htm",
    ".html",
    ".ini",
    ".java",
    ".js",
    ".json",
    ".jsx",
    ".kt",
    ".less",
    ".lua",
    ".m",
    ".md",
    ".org",
    ".php",
    ".pl",
    ".ps1",
    ".py",
    ".r",
    ".rb",
    ".rs",
    ".rst",
    ".sass",
    ".scala",
    ".scss",
    ".sh",
    ".sql",
    ".swift",
    ".tcl",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".vim",
    ".vimrc",
    ".xml",
    ".yaml",
    ".yml",
    ".zsh",
  ];

  if (textExtensions.includes(ext)) {
    return true;
  }

  // Sample file content for binary detection
  let fileHandle;
  try {
    fileHandle = await fs.open(filePath, "r");

    const SAMPLE_SIZE = 8192; // 8KB
    const buffer = Buffer.alloc(SAMPLE_SIZE);
    const { bytesRead } = await fileHandle.read(buffer, 0, SAMPLE_SIZE, 0);
    const sampleBuffer = buffer.subarray(0, bytesRead);

    // Check for null bytes (strong indicator of binary content)
    if (sampleBuffer.includes(0)) {
      return false;
    }

    // Check for valid UTF-8 encoding
    try {
      const text = sampleBuffer.toString("utf8");
      // If decoding succeeds, check character distribution
      const printableChars = text.split("").filter((char) => {
        const code = char.charCodeAt(0);
        // Allow printable ASCII, common whitespace, and Unicode characters
        return (
          (code >= 32 && code <= 126) || // Printable ASCII
          code === 9 || // Tab
          code === 10 || // Line feed
          code === 13 || // Carriage return
          code > 126 // Unicode characters
        );
      }).length;

      const printableRatio = printableChars / text.length;
      return printableRatio > 0.95; // 95% printable characters
    } catch {
      return false; // Invalid UTF-8
    }
  } catch {
    return false; // File cannot be opened
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}
export async function detectFileType(
  filePath: string,
): Promise<FileTypeInfo | undefined> {
  // First check if file exists
  try {
    await fs.stat(filePath);
  } catch {
    return undefined; // File does not exist or cannot be accessed
  }

  const extension = path.extname(filePath).toLowerCase();
  let mimeType: string | undefined;
  let category: FileCategory;

  try {
    // First try magic number detection (most reliable)
    const fileType = await fileTypeFromFile(filePath);
    if (fileType) {
      mimeType = fileType.mime;
      category = categorizeFileType(mimeType);
    } else {
      // Fallback to extension-based detection
      mimeType = lookup(filePath) || "application/octet-stream";
      category = categorizeFileType(mimeType);

      // For unknown MIME types, try content analysis
      if (category === FileCategory.UNSUPPORTED) {
        const isText = await isLikelyTextFile(filePath);
        if (isText) {
          mimeType = "text/plain";
          category = FileCategory.TEXT;
        }
      }
    }
  } catch {
    // If all detection fails, fallback to extension or content analysis
    mimeType = lookup(filePath) || "application/octet-stream";
    category = categorizeFileType(mimeType);

    if (category === FileCategory.UNSUPPORTED) {
      try {
        const isText = await isLikelyTextFile(filePath);
        if (isText) {
          mimeType = "text/plain";
          category = FileCategory.TEXT;
        }
      } catch {
        // Final fallback
        mimeType = "application/octet-stream";
        category = FileCategory.UNSUPPORTED;
      }
    }
  }

  return {
    category,
    mimeType,
    extension,
  };
}

export async function validateFileSize(
  filePath: string,
  category: FileCategory,
): Promise<{ isValid: boolean; actualSize: number; maxSize: number }> {
  const stats = await fs.stat(filePath);
  const actualSize = stats.size;

  let maxSize: number;
  switch (category) {
    case FileCategory.TEXT:
      // No size limit for text files - tree-sitter minimap handles large files
      return { isValid: true, actualSize, maxSize: Infinity };
    case FileCategory.IMAGE:
      maxSize = FILE_SIZE_LIMITS.IMAGE;
      break;
    case FileCategory.PDF:
      maxSize = FILE_SIZE_LIMITS.PDF;
      break;
    default:
      maxSize = 0; // Unsupported files have no size limit as they're rejected anyway
      break;
  }

  return {
    isValid: actualSize <= maxSize,
    actualSize,
    maxSize,
  };
}
