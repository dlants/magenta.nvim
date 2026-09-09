import { promises as fs } from "node:fs";
import { vi } from "vitest";

const isRecording = process.env.RECORD === "true";

// Mock filesystem helpers for GitHub token files
export class MockFileSystem {
  private files: Map<string, string> = new Map();

  setFile(filePath: string, content: string) {
    this.files.set(filePath, content);
  }

  clear() {
    this.files.clear();
  }

  mockFsPromises() {
    // When recording, don't intercept filesystem calls
    if (isRecording) {
      return () => {}; // Return no-op cleanup function
    }

    const originalAccess = fs.access;
    const originalReadFile = fs.readFile;

    vi.spyOn(fs, "access").mockImplementation(async (path) => {
      const pathStr = path.toString();
      if (this.files.has(pathStr)) {
        return Promise.resolve();
      }
      // Fall back to real filesystem
      return originalAccess(path);
    });

    vi.spyOn(fs, "readFile").mockImplementation((path, encoding) => {
      const pathStr = path.toString();
      const content = this.files.get(pathStr);
      if (content !== undefined) {
        return Promise.resolve(
          encoding === "utf-8" ? content : Buffer.from(content),
        );
      }
      // Fall back to real filesystem
      return originalReadFile(path, encoding);
    });

    return () => {
      vi.mocked(fs.access).mockRestore();
      vi.mocked(fs.readFile).mockRestore();
    };
  }
}
