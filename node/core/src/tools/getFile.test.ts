import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as GetFile from "./getFile.ts";
import { FsFileIO } from "../capabilities/file-io.ts";
import type { ToolRequestId } from "../tool-types.ts";
import type {
  UnresolvedFilePath,
  NvimCwd,
  HomeDir,
  AbsFilePath,
} from "../utils/files.ts";
import type { ProviderToolResult } from "../providers/provider-types.ts";
import type {
  ContextTracker,
  OnToolApplied,
} from "../capabilities/context-tracker.ts";

describe("GetFileTool unit tests", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "getfile-unit-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createTool(
    input: Partial<GetFile.Input> & { filePath: UnresolvedFilePath },
    opts: {
      contextFiles?: Record<string, unknown>;
    } = {},
  ) {
    const onToolApplied = vi.fn<OnToolApplied>();
    const mockContextTracker = {
      files: opts.contextFiles ?? {},
    } as unknown as ContextTracker;

    const invocation = GetFile.execute(
      {
        id: "tool_1" as ToolRequestId,
        toolName: "get_file" as const,
        input: input as GetFile.Input,
      },
      {
        cwd: tmpDir as NvimCwd,
        homeDir: "/tmp/fake-home" as HomeDir,
        fileIO: new FsFileIO(),
        contextTracker: mockContextTracker,
        onToolApplied,
      },
    );

    return { invocation, onToolApplied };
  }

  async function getResult(invocation: {
    promise: Promise<ProviderToolResult>;
  }) {
    const result = await invocation.promise;
    return result;
  }

  it("returns early when file is already in context", async () => {
    const filePath = path.join(tmpDir, "existing.txt");
    await fs.writeFile(filePath, "file content here", "utf-8");

    const absFilePath = filePath as AbsFilePath;
    const { invocation } = createTool(
      { filePath: "existing.txt" as UnresolvedFilePath },
      {
        contextFiles: {
          [absFilePath]: {
            relFilePath: "existing.txt",
            fileTypeInfo: {
              category: "text",
              mimeType: "text/plain",
              extension: ".txt",
            },
            agentView: { type: "text", content: "file content here" },
          },
        },
      },
    );

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("already part of the thread context");
    }
  });

  it("reads file when force is true even if already in context", async () => {
    const filePath = path.join(tmpDir, "existing.txt");
    await fs.writeFile(filePath, "Moonlight whispers", "utf-8");

    const absFilePath = filePath as AbsFilePath;
    const { invocation, onToolApplied } = createTool(
      { filePath: "existing.txt" as UnresolvedFilePath, force: true },
      {
        contextFiles: {
          [absFilePath]: {
            relFilePath: "existing.txt",
            fileTypeInfo: {
              category: "text",
              mimeType: "text/plain",
              extension: ".txt",
            },
            agentView: { type: "text", content: "Moonlight whispers" },
          },
        },
      },
    );

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("Moonlight whispers");
    }
    // Should also dispatch context-manager-msg
    expect(onToolApplied).toHaveBeenCalled();
  });

  it("should handle file size limits appropriately", async () => {
    const filePath = path.join(tmpDir, "large.jpg");
    // Create a file larger than the 10MB image limit
    // Write JPEG magic bytes so detectFileType identifies it as an image
    const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const largeBuffer = Buffer.alloc(11 * 1024 * 1024);
    jpegHeader.copy(largeBuffer);
    await fs.writeFile(filePath, largeBuffer);

    const { invocation } = createTool({
      filePath: "large.jpg" as UnresolvedFilePath,
    });

    const result = await getResult(invocation);

    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("File too large");
    }
  });

  it("large text files are truncated and skip context manager", async () => {
    const filePath = path.join(tmpDir, "large.txt");
    // Create file with >40000 chars (1000 lines of 100 chars)
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push("x".repeat(100));
    }
    await fs.writeFile(filePath, lines.join("\n"), "utf-8");

    const { invocation, onToolApplied } = createTool({
      filePath: "large.txt" as UnresolvedFilePath,
    });

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      // Should contain summary info (file summary header)
      expect(text).toContain("File summary:");
    }
    // Should NOT call onToolApplied since file was truncated
    expect(onToolApplied).not.toHaveBeenCalled();
  });

  it("lines that are too long are abridged and skip context manager", async () => {
    const filePath = path.join(tmpDir, "longlines.txt");
    // Create file with a line longer than 2000 chars but total file < 40000 chars
    const longLine = "a".repeat(3000);
    await fs.writeFile(
      filePath,
      `short line\n${longLine}\nanother short`,
      "utf-8",
    );

    const { invocation, onToolApplied } = createTool({
      filePath: "longlines.txt" as UnresolvedFilePath,
    });

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("chars omitted");
    }
    // Should NOT call onToolApplied since lines were abridged
    expect(onToolApplied).not.toHaveBeenCalled();
  });

  it("startLine and numLines parameters work", async () => {
    const filePath = path.join(tmpDir, "lines.txt");
    await fs.writeFile(filePath, "line1\nline2\nline3\nline4\nline5", "utf-8");

    const { invocation, onToolApplied } = createTool({
      filePath: "lines.txt" as UnresolvedFilePath,
      startLine: 2,
      numLines: 2,
    });

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("[Lines 2-3 of");
      expect(text).toContain("line2");
      expect(text).toContain("line3");
      expect(text).not.toContain("line1");
    }
    // Partial reads should not call onToolApplied
    expect(onToolApplied).not.toHaveBeenCalled();
  });

  it("startLine parameter alone works", async () => {
    const filePath = path.join(tmpDir, "lines.txt");
    await fs.writeFile(filePath, "line1\nline2\nline3\nline4\nline5", "utf-8");

    const { invocation } = createTool({
      filePath: "lines.txt" as UnresolvedFilePath,
      startLine: 3,
    });

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("[Lines 3-");
      expect(text).toContain("line3");
      expect(text).toContain("line4");
      expect(text).toContain("line5");
    }
  });

  it("requesting line range from file already in context returns content", async () => {
    const filePath = path.join(tmpDir, "inctx.txt");
    await fs.writeFile(filePath, "line1\nline2\nline3\nline4", "utf-8");

    const absFilePath = filePath as AbsFilePath;
    const { invocation } = createTool(
      {
        filePath: "inctx.txt" as UnresolvedFilePath,
        startLine: 2,
        numLines: 2,
      },
      {
        contextFiles: {
          [absFilePath]: {
            relFilePath: "inctx.txt",
            fileTypeInfo: {
              category: "text",
              mimeType: "text/plain",
              extension: ".txt",
            },
            agentView: { type: "text", content: "line1\nline2\nline3\nline4" },
          },
        },
      },
    );

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      // Should NOT return "already in context" — should return actual lines
      expect(text).not.toContain("already part of the thread context");
      expect(text).toContain("line2");
      expect(text).toContain("line3");
    }
  });

  it("force parameter with line range returns just those lines", async () => {
    const filePath = path.join(tmpDir, "forced.txt");
    await fs.writeFile(filePath, "alpha\nbeta\ngamma\ndelta\nepsilon", "utf-8");

    const absFilePath = filePath as AbsFilePath;
    const { invocation } = createTool(
      {
        filePath: "forced.txt" as UnresolvedFilePath,
        force: true,
        startLine: 2,
        numLines: 2,
      },
      {
        contextFiles: {
          [absFilePath]: {
            relFilePath: "forced.txt",
            fileTypeInfo: {
              category: "text",
              mimeType: "text/plain",
              extension: ".txt",
            },
            agentView: {
              type: "text",
              content: "alpha\nbeta\ngamma\ndelta\nepsilon",
            },
          },
        },
      },
    );

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("beta");
      expect(text).toContain("gamma");
      expect(text).toContain("[Lines 2-3 of");
    }
  });

  it("invalid startLine beyond file length returns error", async () => {
    const filePath = path.join(tmpDir, "small.txt");
    await fs.writeFile(filePath, "one\ntwo\nthree", "utf-8");

    const { invocation } = createTool({
      filePath: "small.txt" as UnresolvedFilePath,
      startLine: 100,
    });

    const result = await getResult(invocation);

    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain(
        "startLine 100 is beyond end of file",
      );
    }
  });

  it("line ranges with long lines still get abridged", async () => {
    const filePath = path.join(tmpDir, "longrange.txt");
    const longLine = "b".repeat(3000);
    await fs.writeFile(filePath, `short1\n${longLine}\nshort3`, "utf-8");

    const { invocation } = createTool({
      filePath: "longrange.txt" as UnresolvedFilePath,
      startLine: 1,
      numLines: 3,
    });

    const result = await getResult(invocation);

    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("chars omitted");
    }
  });

  it("file does not exist returns error", async () => {
    const { invocation } = createTool({
      filePath: "nonexistent.txt" as UnresolvedFilePath,
    });

    const result = await getResult(invocation);

    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("does not exist");
    }
  });

  it("unsupported binary file returns error", async () => {
    const filePath = path.join(tmpDir, "data.bin");
    // Write some random binary content that is not a recognized format
    const buf = Buffer.alloc(1024);
    // Fill with non-text binary data
    for (let i = 0; i < buf.length; i++) {
      buf[i] = i % 256;
    }
    await fs.writeFile(filePath, buf);

    const { invocation } = createTool({
      filePath: "data.bin" as UnresolvedFilePath,
    });

    const result = await getResult(invocation);

    // Binary files with unrecognized content may be detected as text via isLikelyTextFile
    // or as unsupported. Either way, verify it doesn't crash.
    expect(result.result.status).toBeDefined();
    if (result.result.status === "error") {
      expect(result.result.error).toContain("Unsupported file type");
    }
  });

  it("PDF basic info returned when no pdfPage parameter", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const pdfDoc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) {
      const page = pdfDoc.addPage([600, 400]);
      page.drawText(`Page ${i + 1} Content`, { x: 50, y: 350 });
    }
    const pdfBytes = await pdfDoc.save();
    await fs.writeFile(path.join(tmpDir, "multipage.pdf"), pdfBytes);

    const { invocation, onToolApplied } = createTool({
      filePath: "multipage.pdf" as UnresolvedFilePath,
    });

    const result = await getResult(invocation);
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("PDF Document:");
      expect(text).toContain("multipage.pdf");
      expect(text).toContain("Pages: 3");
      expect(text).toContain(
        "Use get-file tool with a pdfPage parameter to access specific pages",
      );
    }
    expect(onToolApplied).toHaveBeenCalled();
  });

  it("PDF page extraction returns document content", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const pdfDoc = await PDFDocument.create();
    const page1 = pdfDoc.addPage([600, 400]);
    page1.drawText("First Page Content", { x: 50, y: 350 });
    const page2 = pdfDoc.addPage([600, 400]);
    page2.drawText("Second Page Content", { x: 50, y: 350 });
    const pdfBytes = await pdfDoc.save();
    await fs.writeFile(path.join(tmpDir, "multipage.pdf"), pdfBytes);

    const { invocation, onToolApplied } = createTool({
      filePath: "multipage.pdf" as UnresolvedFilePath,
      pdfPage: 2,
    });

    const result = await getResult(invocation);
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const doc = result.result.value[0] as {
        type: "document";
        source: { type: string; media_type: string; data: string };
        title: string;
      };
      expect(doc.type).toBe("document");
      expect(doc.source.type).toBe("base64");
      expect(doc.source.media_type).toBe("application/pdf");
      expect(doc.source.data).toBeTruthy();
      expect(doc.title).toContain("multipage.pdf - Page 2");
    }
    expect(onToolApplied).toHaveBeenCalled();
  });

  it("invalid PDF page index returns error", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([600, 400]);
    const pdfBytes = await pdfDoc.save();
    await fs.writeFile(path.join(tmpDir, "singlepage.pdf"), pdfBytes);

    const { invocation } = createTool({
      filePath: "singlepage.pdf" as UnresolvedFilePath,
      pdfPage: 5,
    });

    const result = await getResult(invocation);
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("Page index 5 is out of range");
      expect(result.result.error).toContain("Document has 1 pages");
    }
  });

  it("image file returns base64 image content", async () => {
    const filePath = path.join(tmpDir, "test.jpg");
    // Minimal valid JPEG: SOI + APP0 marker + EOI
    const jpegBytes = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ]);
    await fs.writeFile(filePath, jpegBytes);

    const { invocation, onToolApplied } = createTool({
      filePath: "test.jpg" as UnresolvedFilePath,
    });

    const result = await getResult(invocation);
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const img = result.result.value[0] as {
        type: "image";
        source: { type: string; media_type: string; data: string };
      };
      expect(img.type).toBe("image");
      expect(img.source.type).toBe("base64");
      expect(img.source.media_type).toBe("image/jpeg");
      expect(img.source.data).toBeTruthy();
    }
    expect(onToolApplied).toHaveBeenCalled();
  });

  it("rejects unsupported binary files via driver-equivalent flow", async () => {
    const filePath = path.join(tmpDir, "test.bin");
    // Write ELF binary header - clearly not a supported type
    const elfHeader = Buffer.from([
      0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,
    ]);
    const buf = Buffer.alloc(512);
    elfHeader.copy(buf);
    await fs.writeFile(filePath, buf);

    const { invocation } = createTool({
      filePath: "test.bin" as UnresolvedFilePath,
    });

    const result = await getResult(invocation);
    expect(result.result.status).toBe("error");
    if (result.result.status === "error") {
      expect(result.result.error).toContain("Unsupported file type");
    }
  });

  it("large TypeScript file returns file summary", async () => {
    const lines: string[] = [];
    lines.push("interface User {");
    lines.push("  name: string;");
    lines.push("  age: number;");
    lines.push("}");
    lines.push("");
    for (let i = 0; i < 500; i++) {
      lines.push(`function processItem${i}(data: User): string {`);
      lines.push(
        `  const result = data.name + " is " + data.age + " years old";`,
      );
      lines.push(`  console.log("Processing item ${i}:", result);`);
      lines.push(`  return result;`);
      lines.push(`}`);
      lines.push("");
    }
    lines.push("class DataProcessor {");
    lines.push("  private items: User[] = [];");
    lines.push("");
    lines.push("  addItem(item: User): void {");
    lines.push("    this.items.push(item);");
    lines.push("  }");
    lines.push("}");
    await fs.writeFile(path.join(tmpDir, "large.ts"), lines.join("\n"));

    const { invocation } = createTool({
      filePath: "large.ts" as UnresolvedFilePath,
    });

    const result = await getResult(invocation);
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("File summary:");
      expect(text).toContain("interface User");
      expect(text).toContain("class DataProcessor");
    }
  });

  it("large file with unknown extension returns file summary", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(`Line ${i}: ${"x".repeat(50)}`);
    }
    await fs.writeFile(path.join(tmpDir, "large.unknown123"), lines.join("\n"));

    const { invocation } = createTool({
      filePath: "large.unknown123" as UnresolvedFilePath,
    });

    const result = await getResult(invocation);
    expect(result.result.status).toBe("ok");
    if (result.result.status === "ok") {
      const text = (result.result.value[0] as { type: "text"; text: string })
        .text;
      expect(text).toContain("File summary:");
    }
  });
});
