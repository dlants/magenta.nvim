import { test, expect } from "vitest";
import { extractPDFPage, getPDFPageCount } from "./pdf-pages.ts";
import { withDriver } from "../test/preamble.ts";
import { PDFDocument } from "pdf-lib";
import fs from "fs";
import path from "path";
import type { AbsFilePath } from "./files.ts";

test("getPDFPageCount returns correct page count", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        // Create a simple multi-page PDF for testing
        const pdfDoc = await PDFDocument.create();

        // Add three pages
        const page1 = pdfDoc.addPage([600, 400]);
        page1.drawText("Page 1", { x: 50, y: 350 });

        const page2 = pdfDoc.addPage([600, 400]);
        page2.drawText("Page 2", { x: 50, y: 350 });

        const page3 = pdfDoc.addPage([600, 400]);
        page3.drawText("Page 3", { x: 50, y: 350 });

        const pdfBytes = await pdfDoc.save();
        const testPdfPath = path.join(tmpDir, "test.pdf");
        await fs.promises.writeFile(testPdfPath, pdfBytes);
      },
    },
    async (driver) => {
      const { getcwd } = await import("../nvim/nvim.ts");
      const cwd = await getcwd(driver.nvim);
      const testPdfPath = path.join(cwd, "test.pdf") as AbsFilePath;

      const result = await getPDFPageCount(testPdfPath);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.value).toBe(3);
      }
    },
  );
});

test("extractPDFPage extracts valid page", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        // Create a simple multi-page PDF for testing
        const pdfDoc = await PDFDocument.create();

        const page1 = pdfDoc.addPage([600, 400]);
        page1.drawText("First Page Content", { x: 50, y: 350 });

        const page2 = pdfDoc.addPage([600, 400]);
        page2.drawText("Second Page Content", { x: 50, y: 350 });

        const pdfBytes = await pdfDoc.save();
        const testPdfPath = path.join(tmpDir, "test.pdf");
        await fs.promises.writeFile(testPdfPath, pdfBytes);
      },
    },
    async (driver) => {
      const { getcwd } = await import("../nvim/nvim.ts");
      const cwd = await getcwd(driver.nvim);
      const testPdfPath = path.join(cwd, "test.pdf") as AbsFilePath;

      // Extract the first page (index 0)
      const result = await extractPDFPage(testPdfPath, 1);

      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        // Verify we got valid PDF bytes back
        expect(result.value).toBeInstanceOf(Uint8Array);
        expect(result.value.length).toBeGreaterThan(0);

        // Verify the extracted page is a valid PDF with 1 page
        const extractedPdf = await PDFDocument.load(result.value);
        expect(extractedPdf.getPageCount()).toBe(1);
      }
    },
  );
});

test("extractPDFPage handles invalid page index", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        // Create a simple single-page PDF
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([600, 400]);
        page.drawText("Only Page", { x: 50, y: 350 });

        const pdfBytes = await pdfDoc.save();
        const testPdfPath = path.join(tmpDir, "test.pdf");
        await fs.promises.writeFile(testPdfPath, pdfBytes);
      },
    },
    async (driver) => {
      const { getcwd } = await import("../nvim/nvim.ts");
      const cwd = await getcwd(driver.nvim);
      const testPdfPath = path.join(cwd, "test.pdf") as AbsFilePath;

      // Try to extract page index 5 (out of range)
      const result = await extractPDFPage(testPdfPath, 6);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toContain("Page index 6 is out of range");
        expect(result.error).toContain("Document has 1 pages");
      }
    },
  );
});

test("extractPDFPage handles negative page index", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        // Create a simple PDF
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage([600, 400]);
        page.drawText("Test Page", { x: 50, y: 350 });

        const pdfBytes = await pdfDoc.save();
        const testPdfPath = path.join(tmpDir, "test.pdf");
        await fs.promises.writeFile(testPdfPath, pdfBytes);
      },
    },
    async (driver) => {
      const { getcwd } = await import("../nvim/nvim.ts");
      const cwd = await getcwd(driver.nvim);
      const testPdfPath = path.join(cwd, "test.pdf") as AbsFilePath;

      // Try to extract page index -1
      const result = await extractPDFPage(testPdfPath, 0);

      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.error).toContain("Page index 0 is out of range");
      }
    },
  );
});

test("functions handle non-existent file", async () => {
  await withDriver({}, async (driver) => {
    const { getcwd } = await import("../nvim/nvim.ts");
    const cwd = await getcwd(driver.nvim);
    const nonExistentPath = path.join(cwd, "nonexistent.pdf") as AbsFilePath;

    const pageCountResult = await getPDFPageCount(nonExistentPath);
    expect(pageCountResult.status).toBe("error");
    if (pageCountResult.status === "error") {
      expect(pageCountResult.error).toContain("Failed to get PDF page count");
    }

    const pageResult = await extractPDFPage(nonExistentPath, 1);
    expect(pageResult.status).toBe("error");
    if (pageResult.status === "error") {
      expect(pageResult.error).toContain("Failed to extract PDF page");
    }
  });
});

test("functions handle invalid PDF file", async () => {
  await withDriver(
    {
      setupFiles: async (tmpDir) => {
        // Create a file that's not a valid PDF
        const invalidPdfPath = path.join(tmpDir, "invalid.pdf");
        await fs.promises.writeFile(invalidPdfPath, "This is not a PDF file");
      },
    },
    async (driver) => {
      const { getcwd } = await import("../nvim/nvim.ts");
      const cwd = await getcwd(driver.nvim);
      const invalidPdfPath = path.join(cwd, "invalid.pdf") as AbsFilePath;

      const pageCountResult = await getPDFPageCount(invalidPdfPath);
      expect(pageCountResult.status).toBe("error");
      if (pageCountResult.status === "error") {
        expect(pageCountResult.error).toContain("Failed to get PDF page count");
      }

      const pageResult = await extractPDFPage(invalidPdfPath, 1);
      expect(pageResult.status).toBe("error");
      if (pageResult.status === "error") {
        expect(pageResult.error).toContain("Failed to extract PDF page");
      }
    },
  );
});
