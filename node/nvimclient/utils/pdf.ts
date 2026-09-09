import fs from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Result } from "./result.ts";

export async function extractPdfText(
  filePath: string,
): Promise<Result<string>> {
  try {
    // Load the PDF file from disk
    const data = new Uint8Array(fs.readFileSync(filePath));

    const loadingTask = getDocument({
      data,
      useSystemFonts: true,
    });

    const pdf = await loadingTask.promise;
    const textContent: string[] = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();

      // Extract text items and join them
      const pageText = content.items
        .map((item) => {
          if ("str" in item) {
            return item.str;
          }
          return "";
        })
        .join(" ");

      if (pageText.trim()) {
        textContent.push(`\n--- Page ${pageNum} ---\n${pageText}`);
      }

      // Clean up page resources
      page.cleanup();
    }

    const fullText = textContent.join("\n");

    return {
      status: "ok",
      value: fullText,
    };
  } catch (error) {
    return {
      status: "error",
      error: `Failed to extract text from PDF: ${(error as Error).message}`,
    };
  }
}
