import { PDFDocument } from "pdf-lib";
import fs from "fs";
import type { Result } from "./result.ts";
import type { AbsFilePath } from "./files.ts";
import type { ProviderToolResultContent } from "../providers/provider-types.ts";

export async function extractPDFPage(
  filePath: AbsFilePath,
  pageIndex: number,
): Promise<Result<Uint8Array>> {
  try {
    // Read the PDF file
    const existingPdfBytes = await fs.promises.readFile(filePath);

    // Load the PDF document
    const pdfDoc = await PDFDocument.load(existingPdfBytes);

    // Check if page index is valid
    const pageCount = pdfDoc.getPageCount();
    if (pageIndex < 1 || pageIndex > pageCount) {
      return {
        status: "error",
        error: `Page index ${pageIndex} is out of range. Document has ${pageCount} pages (1-${pageCount}).`,
      };
    }

    // Create a new PDF document for the single page
    const newPdfDoc = await PDFDocument.create();

    // Copy the specific page
    const [copiedPage] = await newPdfDoc.copyPages(pdfDoc, [pageIndex - 1]);
    newPdfDoc.addPage(copiedPage);

    // Save the new PDF as bytes
    const pdfBytes = await newPdfDoc.save();

    return {
      status: "ok",
      value: new Uint8Array(pdfBytes),
    };
  } catch (error) {
    return {
      status: "error",
      error: `Failed to extract PDF page ${pageIndex}: ${(error as Error).message}`,
    };
  }
}

export async function getPDFPageCount(
  filePath: AbsFilePath,
): Promise<Result<number>> {
  try {
    // Read the PDF file
    const existingPdfBytes = await fs.promises.readFile(filePath);

    // Load the PDF document
    const pdfDoc = await PDFDocument.load(existingPdfBytes);

    // Get page count
    const pageCount = pdfDoc.getPageCount();

    return {
      status: "ok",
      value: pageCount,
    };
  } catch (error) {
    return {
      status: "error",
      error: `Failed to get PDF page count: ${(error as Error).message}`,
    };
  }
}

export async function getSummaryAsProviderContent(
  filePath: AbsFilePath,
): Promise<Result<ProviderToolResultContent[]>> {
  const pageCountResult = await getPDFPageCount(filePath);

  if (pageCountResult.status === "error") {
    return pageCountResult;
  }

  return {
    status: "ok",
    value: [
      {
        type: "text",
        text: `PDF Document: ${filePath}
Pages: ${pageCountResult.value}

Use get-file tool with a pdfPage parameter to access specific pages.`,
      },
    ],
  };
}
