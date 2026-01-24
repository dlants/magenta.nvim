import type { Position } from "./embedding/types.ts";

export type ChunkInfo = {
  text: string;
  start: Position;
  end: Position;
};

const DEFAULT_CHUNK_SIZE = 2000; // ~500 tokens
const DEFAULT_OVERLAP = 200; // ~50 tokens overlap

export function chunkText(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  overlap: number = DEFAULT_OVERLAP,
): ChunkInfo[] {
  const chunks: ChunkInfo[] = [];
  const lines = text.split("\n");

  let currentChunk = "";
  let chunkStartLine = 1;
  let chunkStartCol = 1;
  let currentLine = 1;
  let currentCol = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineWithNewline = i < lines.length - 1 ? line + "\n" : line;

    if (
      currentChunk.length + lineWithNewline.length > chunkSize &&
      currentChunk.length > 0
    ) {
      // Save the current chunk
      chunks.push({
        text: currentChunk,
        start: { line: chunkStartLine, col: chunkStartCol },
        end: { line: currentLine - 1, col: lines[currentLine - 2]?.length ?? 1 },
      });

      // Start a new chunk with overlap
      const overlapStart = Math.max(0, currentChunk.length - overlap);
      const overlapText = currentChunk.slice(overlapStart);

      // Find where the overlap starts in terms of line/col
      const overlapLines = overlapText.split("\n");
      const linesInChunk = currentChunk.split("\n");
      const overlapStartLineOffset = linesInChunk.length - overlapLines.length;

      chunkStartLine = chunkStartLine + overlapStartLineOffset;
      chunkStartCol =
        overlapLines.length === linesInChunk.length
          ? linesInChunk[overlapStartLineOffset].length -
            overlapLines[0].length +
            1
          : 1;

      currentChunk = overlapText;
    }

    if (currentChunk.length === 0) {
      chunkStartLine = currentLine;
      chunkStartCol = 1;
    }

    currentChunk += lineWithNewline;
    currentLine++;
    currentCol = 1;
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push({
      text: currentChunk,
      start: { line: chunkStartLine, col: chunkStartCol },
      end: { line: lines.length, col: lines[lines.length - 1]?.length ?? 1 },
    });
  }

  return chunks;
}
